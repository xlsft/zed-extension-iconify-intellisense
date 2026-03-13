'use strict';

const fs = require('fs'), path = require('path'), os = require('os')

const regex = { icon: /([a-z0-9-]+):([a-z0-9-]*)/gi, lines: /\r?\n/, header: /Content-Length: (\d+)/i }
const cache = { root: null, root_checked: false, collections: new Map(), icons: new Map(), documents: new Map(), buffer: '' }

const resolve = {
    path: () => {
        const candidates = new Set()
        const add = (value) => { if (value) candidates.add(value) }
        const add_root = (root) => { if (root) add(path.join(root, 'collections.json')) }
        const add_node_modules = (root) => { if (root) add(path.join(root, 'node_modules', '@iconify', 'json', 'collections.json')) }

        if (process.env.ICONIFY_JSON_PATH) add(process.env.ICONIFY_JSON_PATH)
        if (process.env.ICONIFY_JSON_ROOT) add_root(process.env.ICONIFY_JSON_ROOT)

        if (process.env.NODE_PATH) {
            for (const entry of process.env.NODE_PATH.split(path.delimiter)) add(path.join(entry, '@iconify', 'json', 'collections.json'))
        }

        try { add(require.resolve('@iconify/json/collections.json')) } catch {}

        const search_up = (start) => {
            if (!start) return
            let dir = path.resolve(start)
            while (true) {
                add_node_modules(dir)
                const parent = path.dirname(dir)
                if (parent === dir) break
                dir = parent
            }
        }

        search_up(__dirname)
        try { search_up(process.cwd()) } catch {}

        const extension_id = process.env.ZED_EXTENSION_ID || 'iconify-intellisense'
        const home = os.homedir && os.homedir()

        if (process.env.XDG_DATA_HOME) add(path.join(process.env.XDG_DATA_HOME, 'zed', 'extensions', 'work', extension_id, 'node_modules', '@iconify', 'json', 'collections.json'))
        if (home) {
            add(path.join(home, '.local', 'share', 'zed', 'extensions', 'work', extension_id, 'node_modules', '@iconify', 'json', 'collections.json'))
            add(path.join(home, 'Library', 'Application Support', 'Zed', 'extensions', 'work', extension_id, 'node_modules', '@iconify', 'json', 'collections.json'))
        }
        if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'Zed', 'extensions', 'work', extension_id, 'node_modules', '@iconify', 'json', 'collections.json'))

        for (const candidate of candidates) {
            try {
                if (candidate && fs.statSync(candidate).isFile()) return candidate
            } catch {}
        }
        return null
    },
    root: () => {
        if (cache.root_checked) return cache.root
        cache.root_checked = true
        const path = resolve.path()
        cache.root = path ? path.dirname(path) : null
        return cache.root
    }
}

const get = {
    collection: (name) => { try {
        const key = name.toLowerCase(); if (cache.collections.has(key)) return cache.collections.get(key)
        const collections = resolve.root(); if (!collections) { cache.collections.set(key, null); return null }
        const collection = path.join(collections, 'json', `${key}.json`); if (!fs.existsSync(collection)) { cache.collections.set(key, null); return null }
        const parsed = JSON.parse(fs.readFileSync(collection, 'utf8')); cache.collections.set(key, parsed)
        return parsed;
    } catch (error) { cache.collections.set(name.toLowerCase(), null); return null }},
    icon: (collection, name, size = 64) => {
        const col = get.collection(collection); if (!col || !col.icons || !col.icons[name]) return null
        const icon = col.icons[name]; if (!icon || !icon.body) return null
        const options = {
            viewbox: `0 0 ${icon.width || col.width || 64} ${icon.height || col.height || 64}`,
            width: size || 64,
            height: Math.max(1, Math.round(((icon.height || col.height || 64) / (icon.width || col.width || 64)) * size || 64)),
            color: '#FFFFFF'
        }
        return `<svg viewBox="${options.viewbox}" width="${options.width}" height="${options.height}" fill="currentColor"><style>path { fill: ${options.color} !important; }</style>${icon.body}</svg>`;
    },
    context: (text, position) => {
        const lines = text.split(regex.lines); if (position.line >= lines.length) return null
        const line = lines[position.line]; regex.icon.lastIndex = 0; let match = regex.icon.exec(line);
        while (match) {
            const start = match.index, end = start + match[0].length; if (position.character >= start && position.character <= end) return {
                pack: match[1].toLowerCase(),
                icon: match[2],
                query: line.slice(start + match[1].length + 1, position.character),
            }
            match = regex.icon.exec(line);
        }
        return null;
    },
    offset: (text, position) => {
        let line = 0, character = 0; for (let i = 0; i < text.length; i += 1) {
            if (line === position.line && character === position.character) return i
            if (text[i] === '\n') { line += 1; character = 0 }
            else character += 1
        }
        return text.length;
    },
    completion: (collection, query, position) => {
        const key = collection.toLowerCase(); let icons; if (cache.icons.has(key)) icons = cache.icons.get(key); else {
            const col = get.collection(key)
            icons = col && col.icons ? Object.keys(col.icons) : []
            cache.icons.set(key, icons)
        }; if (!icons || icons.length === 0) return []

        const q = query.toLowerCase(); let candidates = []; if (q.length === 0) candidates = icons.slice().sort(); else {
            for (const icon of icons) {
                const candidate = icon.toLowerCase()
                let score = 0, index = 0, streak = 0;
                for (let i = 0; i < candidate.length && index < q.length; i += 1) if (candidate[i] === q[index]) { index += 1; streak += 1; score += 10 + streak * 2 } else streak = 0
                if (index < q.length) continue
                score -= candidate.length - q.length;
                candidates.push({ icon, score });
            }
            candidates.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score
                return a.icon.localeCompare(b.icon);
            }); candidates = candidates.map((entry) => entry.icon);
        }
        return candidates.slice(0, 200).map((icon) => ({
            label: icon,
            kind: 1,
            detail: collection,
            textEdit: {
                range: {
                    start: { line: position.line, character: position.character - query.length },
                    end: { line: position.line, character: position.character },
                },
                newText: icon,
            },
        }));
    },
    tokens: (text) => {
        const matches = [], lines = text.split(regex.lines); for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]; regex.icon.lastIndex = 0;
            let match = regex.icon.exec(line); while (match) {
                matches.push({
                    line: i,
                    start: match.index,
                    length: match[0].length,
                    pack: match[1].toLowerCase(),
                    icon: match[2],
                });
                match = regex.icon.exec(line);
            }
        }
        const data = [], last = { line: 0, start: 0 }; for (const token of matches.slice().sort((a, b) => {
            if (a.line !== b.line) return a.line - b.line;
            return a.start - b.start;
        })) {
            const delta = {
                line: token.line - last.line,
                start: (token.line - last.line) === 0 ? token.start - last.start : token.start
            }; data.push(delta.line, delta.start, token.length, 0, 0);
            last = token
        }
        return data;
    },
    message: (svg, context) => `![icon](data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")})\n[${context.pack}:${context.icon}](https://icon-sets.iconify.design/${context.pack}?icon-filter=${encodeURIComponent(context.icon)})`
}

const stdout = {
    message: (payload) => {
        const json = JSON.stringify(payload);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    },
    response: (id, result) => stdout.message({ jsonrpc: '2.0', id, result }),
    error: (id, error) => stdout.message({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message || String(error) } })
}

const stdin = {
    messages: {
        'initialize': (message) => stdout.response(message.id, {
            capabilities: {
                textDocumentSync: 1,
                completionProvider: { triggerCharacters: [':'] },
                hoverProvider: true,
                semanticTokensProvider: {
                    legend: { tokenTypes: ['comment'], tokenModifiers: [] },
                    full: true,
                    range: false,
                },
            },
            serverInfo: { name: "iconify-intellisense-server", version: "0.0.1" },
        }),
        'textDocument/didOpen': (message) => {
            const doc = message.params && message.params.textDocument
            if (doc && typeof doc.text === 'string') cache.documents.set(doc.uri, doc.text)
        },
        'textDocument/didClose': (message) => {
            const doc = message.params && message.params.textDocument
            if (doc && doc.uri) cache.documents.delete(doc.uri)
        },
        'textDocument/didChange': (message) => {
            const params = message.params; if (!params || !params.textDocument || !Array.isArray(params.contentChanges)) return
            const uri = params.textDocument.uri; let text = cache.documents.get(uri) || ''

            for (const change of params.contentChanges) {
                if (!change || typeof change.text !== 'string') continue
                if (change.range) {
                    const start = get.offset(text, change.range.start), end = get.offset(text, change.range.end)
                    text = text.slice(0, start) + change.text + text.slice(end)
                } else text = change.text
            }
            cache.documents.set(uri, text);
        },
        'textDocument/completion': (message) => { try {
            const uri = message.params.textDocument && message.params.textDocument.uri, text = uri ? cache.documents.get(uri) : null; if (!text) { stdout.response(message.id, { isIncomplete: false, items: [] }); return }
            const context = get.context(text, message.params.position); if (!context) { stdout.response(message.id, { isIncomplete: false, items: [] }); return }
            const items = get.completion(context.pack, context.query || '', message.params.position);
            stdout.response(message.id, { isIncomplete: items.length >= 200, items })
        } catch (error) {
            stdout.error(message.id, error)
        }},
        'textDocument/hover': (message) => {
            const uri = message.params && message.params.textDocument && message.params.textDocument.uri
            const text = uri ? cache.documents.get(uri) : null; if (!text) { stdout.response(message.id, null); return }
            const context = get.context(text, message.params.position); if (!context) { stdout.response(message.id, null); return }
            const svg = get.icon(context.pack, context.icon); if (!svg) { stdout.response(message.id, { contents: { kind: 'markdown', value: `\`${context.pack}:${context.icon}\`` }}); return }
            stdout.response(message.id, { contents: { kind: 'markdown', value: get.message(svg, context) }})
        },
        'textDocument/semanticTokens/full': (message) => {
            const uri = message.params && message.params.textDocument && message.params.textDocument.uri
            const text = uri ? cache.documents.get(uri) : null
            const data = text ? get.tokens(text) : []
            stdout.response(message.id, { data })
        },
        'shutdown': (message) => stdout.response(message.id, null),
        'exit': (message) => process.exit(0),
    },
    handle: (chunk) => { try {
        cache.buffer += chunk; while (true) {
            const end = cache.buffer.indexOf('\r\n\r\n'); if (end === -1) break
            const match = cache.buffer.slice(0, end).match(regex.header); if (!match) { cache.buffer = cache.buffer.slice(end + 4); continue }
            const length = Number(match[1]), pos = { start: end + 4, end: end + 4 + length };  if (cache.buffer.length < pos.end) break
            const message = cache.buffer.slice(pos.start, pos.end); cache.buffer = cache.buffer.slice(pos.end);  if (message.trim().length === 0) continue
            const parsed = JSON.parse(message);
            const handler = stdin.messages[parsed.method];
            if (handler) handler(parsed); else if (parsed && parsed.id != null) stdout.error(parsed.id, new Error(`Unhandled method: ${parsed.method}`))
        }
    } catch {}}
}

process.stdin.setEncoding('utf8'); process.stdin.on('data', stdin.handle)
process.stdin.on('end', () => process.exit(0))
