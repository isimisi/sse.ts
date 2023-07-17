import { headerCase } from 'header-case';

export type SSEHeaders = Record<string, string | number | boolean>;

export interface Config {
   headers?: SSEHeaders;
   withCredentials?: boolean;
}

class SSESourceException {
   public error: Error;
   constructor(public message: string, public status = 500, public code = '') {
      this.error = new Error(message);
   }
}

type SourceBody = Record<string, any>;

interface SourceEvent extends CustomEvent {
   source?: Source;
   readyState?: number;
   data: Record<string, any> | string | number | Array<any> | null;
   id?: string | null;
   sse_id: string;
}
interface ListenerCallback {
   (event: SourceEvent): void;
}

export class Source {
   private _initializing = -1;
   private _connecting = 0;
   private _open = 1;
   private _closed = 2;
   private listeners: Record<string, ListenerCallback[]> = {};
   private _readyState = this.INITIALIZING;
   private progress = 0;
   private chunk = '';
   private FIELD_SEPARATOR = ':';
   private reader: ReadableStreamDefaultReader<string> | null = null;
   public onmessage: ListenerCallback = () => {};
   public onerror: ListenerCallback = () => {};
   public onopen: ListenerCallback = () => {};

   get readyState() {
      return this._readyState;
   }

   get INITIALIZING() {
      return this._initializing;
   }

   get CLOSED() {
      return this._closed;
   }

   get OPEN() {
      return this._open;
   }

   get CONNECTING() {
      return this._connecting;
   }

   constructor(
      private url: URL | string,
      private config: Config = {},
      private method: 'GET' | 'POST' = 'GET',
      private body: SourceBody = {}
   ) {
      this.init();
   }

   private transformHeaders(obj?: SSEHeaders) {
      const transformedHeaders: SSEHeaders = {};

      for (const key in obj) {
         if (Object.hasOwnProperty.call(obj, key)) {
            const transformedKey = headerCase(key);
            transformedHeaders[transformedKey] = obj[key];
         }
      }

      return transformedHeaders;
   }

   public addEventListener(type: string, listener: ListenerCallback) {
      if (this.listeners[type] === undefined) {
         this.listeners[type] = [];
      }

      if (this.listeners[type].indexOf(listener) === -1) {
         this.listeners[type].push(listener);
      }
   }

   public removeEventListener(type: string, listener: ListenerCallback) {
      if (this.listeners[type] === undefined) {
         return;
      }

      const filtered: Array<ListenerCallback> = [];
      this.listeners[type].forEach(function (element) {
         if (element !== listener) {
            filtered.push(element);
         }
      });
      if (filtered.length === 0) {
         delete this.listeners[type];
      } else {
         this.listeners[type] = filtered;
      }
   }

   protected dispatchEvent(event?: SourceEvent | null) {
      if (!event) {
         return true;
      }

      event.source = this;

      const onHandler = 'on' + event.type;

      /**
       * Checks if one might've added functions directly on the instance
       *
       * @example source.onmessage = function (event: SourceEvent) {}
       * However I don't know how to implement this in typescript
       */
      if (this.hasOwnProperty.call(this, onHandler)) {
         const handler = this[onHandler as keyof Source] as ListenerCallback;

         if (typeof handler === 'function') {
            handler.call(this, event);
         }
         if (event.defaultPrevented) {
            return false;
         }
      }

      if (this.listeners[event.type]) {
         return this.listeners[event.type].every(function (callback) {
            callback(event);
            return !event.defaultPrevented;
         });
      }

      return true;
   }

   private checkStreamClosed(done: boolean) {
      if (done) {
         this.setReadyState(this.CLOSED);
      }
   }

   private async init() {
      this.setReadyState(this.CONNECTING);

      try {
         const response = await fetch(this.url, {
            method: this.method,
            headers: {
               'Content-Type':
                  this.method === 'GET'
                     ? 'text/event-stream'
                     : 'application/json',
               ...this.transformHeaders(this.config.headers),
            },
            ...(this.config.withCredentials && { credentials: 'include' }),
            ...(this.method === 'POST' && { body: JSON.stringify(this.body) }),
         });

         if (!response.ok) {
            this.onStreamFailure(
               new SSESourceException(response.statusText, response.status)
            );
         }

         this.reader =
            response.body?.pipeThrough(new TextDecoderStream()).getReader() ||
            null;

         if (this.reader) {
            while (this.readyState !== this.CLOSED) {
               const { value, done } = await this.reader.read();

               if (done) {
                  this.checkStreamClosed(done);
                  break;
               }

               this.onStreamLoaded(value);
            }
         } else {
            this.onStreamFailure(
               new SSESourceException('The response did not have a body')
            );
         }
      } catch (error) {
         this.onStreamFailure(error);
      }
   }

   private setReadyState(state: number) {
      const event = new CustomEvent('readystatechange') as SourceEvent;
      event.readyState = state;
      this._readyState = state;
      this.dispatchEvent(event);
   }

   private onStreamFailure(error: any) {
      const event = new CustomEvent('error') as SourceEvent;
      event.data = error;
      this.dispatchEvent(event);
      this.close();
   }

   private onStreamProgress(value: string) {
      if (this.readyState == this.CONNECTING) {
         const event = new CustomEvent('open') as SourceEvent;
         event.data = null;
         this.dispatchEvent(event);
         this.setReadyState(this.OPEN);
      }

      const data = value.substring(this.progress);
      this.progress += data.length;
      data.split(/(\r\n|\r|\n){2}/g).forEach(
         function (this: Source, part: string) {
            if (part.trim().length === 0) {
               this.dispatchEvent(this.parseEventChunk(this.chunk.trim()));
               this.chunk = '';
            } else {
               this.chunk += part;
            }
         }.bind(this)
      );
   }

   private onStreamLoaded(value: string) {
      this.onStreamProgress(value);

      // Parse the last chunk.
      this.dispatchEvent(this.parseEventChunk(this.chunk));
      this.chunk = '';
   }

   /**
    * Parse a received SSE event chunk into a constructed event object.
    */
   private parseEventChunk(chunk: string) {
      if (!chunk || chunk.length === 0) {
         return null;
      }

      const e: Record<string, any> & {
         id: null | string;
         retry: null | number;
         data: any;
         event: string;
         sse_id: string;
      } = {
         id: null,
         retry: null,
         data: '',
         event: 'message',
         sse_id: '',
      };
      chunk.split(/\n|\r\n|\r/).forEach(
         function (this: Source, line: string) {
            line = line.trimEnd();
            const index = line.indexOf(this.FIELD_SEPARATOR);
            if (index <= 0) {
               // Line was either empty, or started with a separator and is a comment.
               // Either way, ignore.
               return;
            }

            const field = line.substring(0, index);
            if (!(field in e)) {
               return;
            }

            const value = line.substring(index + 1).trimLeft();

            if (field === 'data') {
               e[field] += value;
            } else {
               e[field] = value;
            }
         }.bind(this)
      );

      const event = new CustomEvent(e.event) as SourceEvent;
      event.data = e.data;
      event.id = e.id;
      event.sse_id = e.sse_id;
      return event;
   }

   private formatDataOnEvent(event: SourceEvent) {
      if (!event.data) {
         event.data = null;
         return;
      }

      try {
         event.data = JSON.parse(event.data as string);
      } catch (error) {
         return;
      }
   }

   public close() {
      if (this.readyState === this.CLOSED) {
         return;
      }

      this.reader = null;

      this.setReadyState(this.CLOSED);
   }

   /**
    * Adds the listener function as an event listener for the event.
    *
    * @param event the event we want to listen to
    * @param listener the listener function which will recieve the data sent from the server
    *
    * Generally we use this instead of addEventListener, since we only ever want one action on an event
    */
   public on(event: string, listener: (data: SourceEvent) => any) {
      function _listener(this: Source, e: SourceEvent) {
         this.formatDataOnEvent(e);
         listener(e);
      }
      this.listeners[event] = [_listener.bind(this)];
   }

   /**
    * Removes the listener function as an event listener for the event.
    *
    * @param event the event where we want to remove the function off
    *
    * Use this in combination with the "on" method, and not with addEventListener
    */
   public off(event: string) {
      delete this.listeners[event];
   }

   static post(url: URL | string, body: SourceBody, config?: Config) {
      return new this(url, config, 'POST', body);
   }

   static get(url: URL | string, config?: Config) {
      return new this(url, config);
   }
}
