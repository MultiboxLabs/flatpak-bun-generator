# Flatpak Bun Generator

Generate Flatpak source definitions from a `bun.lock` file.

Use it with `bunx`:

```sh
bunx flatpak-bun-generator bun.lock --output generated-sources.json
```

Flags:

- `--output <file>`: write JSON to a custom path
- `--all-os`: include non-Linux packages
- `--no-devel`: exclude dev-only dependencies
- `--registry <url>`: use a custom npm registry base URL
