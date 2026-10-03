# lpqz

A short alias for the [`letsplayquiz`](https://www.npmjs.com/package/letsplayquiz) CLI (**L**et's **P**lay **Q**ui**z**). Use it without installing:

```sh
npx lpqz guide --kind balance
```

This package contains no logic: its one-line `bin.js` loads and runs the real `letsplayquiz` executable. Commands, options and exit codes are exactly those of [`letsplayquiz`](https://github.com/letsplayquiz/letsplayquiz/tree/main/packages/cli#readme).

## Global install

The two packages register different command names, because two packages declaring the same bin name would collide with `EEXIST` on global install.

| Install | Command |
|---|---|
| `npm i -g letsplayquiz` | `letsplayquiz` |
| `npm i -g lpqz` | `lpqz` |

## Publishing (maintainers)

**Publish `letsplayquiz` first, then `lpqz`.** `bin.js` loads `letsplayquiz/dist/bin.js` at runtime, so publishing in the other order leaves a window where `npx lpqz` looks for a `letsplayquiz` version that does not exist yet and fails with `ETARGET`.

## License

MIT
