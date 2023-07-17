# sse.ts
> this project was inspired by sse.js

- [sse.ts](#ssets)
  - [usage in react](#usage-in-react)
  - [API reference](#api-reference)


## usage in react
```ts
export default function MyComponent() {
    const [source, setSource] = useState<Source | null>(null)
    const [message, setMessage] = useState<string>("")

    useEffect(() => {
        const src = Source.get('http://localhost:3333/sse')

        setSource(src);

        return () => {
            src.close()
        }
    }, [])

    useEffect(() => {
        if (source) {
            source.on('message', e => {
                setMessage(e.data.message);
            })
        }

        return () => {
            if (source) {
                source.off('message')
            }
        }
    }, [source])

    return <div>{message}</div>
};

```

## API reference

| Type   | Method      | returns |            args        |                                    |        |
|--------|-------------|---------|--------------------|------------------------------------|--------|
| static | Source.get  | Source  | url: string \| URL | config                             |        |
| static | Source.post | Source  | url: string \| URL | body: object                       | config |
| public | source.on   | void    | event: string      | listener: (e: SourceEvent) => void |        |
| public | source.off  | void    | event: string      |                                    |        |
| public | source.close  | void    |      |                                    |        |

| Type        | Interface                                                                                                           |
|-------------|---------------------------------------------------------------------------------------------------------------------|
| Config      | { <br>  headers?: Record<string, string \| number \| boolean>, <br>  withCredentials?: boolean <br>}                 |
| SourceEvent | extends CustomEvent <br>{ <br>  data: any, <br>  id?: string, <br>  source?: Source, <br>  readyState?: number<br>} |
