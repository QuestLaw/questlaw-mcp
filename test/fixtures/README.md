# Test fixture

A synthetic QuestLaw library, written by the shipped vault stack via
`tools/regen-fixture.js`. Every case in it is invented.

`recovery.txt` is the account key for THIS throwaway vault and opens nothing else.
It is committed on purpose so `npm test` works with no checkout and no network.

Regenerate after a vendor sync:

```sh
node tools/regen-fixture.js --repo <extension checkout>
```
