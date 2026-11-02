# Contributing

Thank you for helping.

- **Bugs and ideas:** open an issue with what you ran, what you expected and what happened. For security problems, see [SECURITY.md](SECURITY.md) instead.
- **Pull requests:** keep them small and focused, with a test where one fits. Before you open one, run:

  ```sh
  (cd hub && npm test) && (cd cli && node --test test/*.test.js) && node --test share/test/*.test.js
  ```

- **Style:**
  - plain Node.js (CommonJS in hub/ and share/);
  - no new runtime dependencies without a reason;
  - comments that say why, not what.
- **Licence:** contributions are under the Apache License 2.0, the same as the project.
