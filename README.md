# sse.ts
> this project was heavily inspired by sse.js


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