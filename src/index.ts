// interface VoidFnWithArgs {
//    (...args: any): void;
// }

class SSESourceException {
   public error: Error;
   constructor(public message: string, public status = 500, public code = '') {
      this.error = new Error(message);
   }
}

type SourceHeaders = Record<string, string>;
type SourceBody = Record<string, any>;

interface SourceEvent extends CustomEvent {
   source?: Source;
   readyState?: number;
   data?: Record<string, any> | string | number | Array<any> | null;
   id?: string | null;
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
      private headers: SourceHeaders = {},
      private method: 'GET' | 'POST' = 'GET',
      private body: SourceBody = {},
    //   private withCredentials = false
   ) {
      this.init();
   }

//    private transformHeaders() {}

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

      if (this.hasOwnProperty.call(this, onHandler)) {
         const handler = this[
            onHandler as keyof Source
         ] as unknown as ListenerCallback;

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
               ...this.headers,
            },
            ...(this.method === 'POST' && { body: JSON.stringify(this.body) }),
         });

         if (!response.ok) {
            this.onStreamFailure(
               new SSESourceException(response.statusText, response.status)
            );
         }

         const reader = response.body
            ?.pipeThrough(new TextDecoderStream())
            .getReader();

         if (reader) {
            while (this.readyState !== 2) {
               const { value, done } = await reader.read();

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
      const event: SourceEvent = new CustomEvent('readystatechange');
      event.readyState = state;
      this._readyState = state;
      this.dispatchEvent(event);
   }

   private onStreamFailure(error: any) {
      const event: SourceEvent = new CustomEvent('error');
      event.data = error;
      this.dispatchEvent(event);
      this.close();
   }

   private onStreamProgress(value: string) {
      if (this.readyState == this.CONNECTING) {
         this.dispatchEvent(new CustomEvent('open'));
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
      } = {
         id: null,
         retry: null,
         data: '',
         event: 'message',
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

      const event: SourceEvent = new CustomEvent(e.event);
      event.data = e.data;
      event.id = e.id;
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

      this.setReadyState(this.CLOSED);
   }

   public on(type: string, listener: (event: SourceEvent) => any) {
      this.addEventListener(type, (e) => {
         this.formatDataOnEvent(e);
         listener(e);
      });
   }

   public off(type: string) {
      delete this.listeners[type];
   }

   static post(url: URL | string, body: SourceBody, headers?: SourceHeaders) {
      return new this(url, headers, 'POST', body);
   }

   static get(url: URL | string, headers?: SourceHeaders) {
      return new this(url, headers);
   }
}
