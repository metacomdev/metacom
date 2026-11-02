# Working in this repository

## Gotchas

- Never delete for cleanup: no rm in routine work, not even with "${VAR:?}". Tests and checks write to a fresh `mktemp -d` directory per run, so nothing ever needs deleting.
