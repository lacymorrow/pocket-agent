# Contributing to Pocket Agent

:+1: First off, thanks for taking the time to contribute! :+1:

Below is a quick guide; for the full details please see the README and our **Security Policy**.

## How Can I Contribute?

### Reporting Bugs
1. **Search existing issues** to avoid duplicates.
2. Open a new issue using the **Bug Report** template.
3. Provide clear steps to reproduce, expected / actual behaviour, and environment details.

### Suggesting Enhancements
1. Look for existing [feature requests](https://github.com/your/repo/issues?q=is%3Aissue+label%3Aenhancement).
2. Submit a **Feature Request** using the provided template.

### Pull Requests
1. Fork & clone the repository.
2. `npm ci --legacy-peer-deps` – install dependencies.
3. `npm run lint && npm test` – make sure everything passes.
4. Create your branch: `git checkout -b feat/my-awesome-feature`.
5. Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/).
6. Push to the branch and open a Pull Request.

The CI will run lint, unit tests, coverage, and integration tests. PRs must be green before merge.

## Code Style
* We use **ESLint** for code correctness and **Prettier** for formatting.
* Run `npm run format` before committing, or configure your editor to format on save.

## Commit Messages & Releases
* Follow **Conventional Commits** (`feat:`, `fix:`, `chore:`…) – this enables automatic versioning with **semantic-release**.

## License
By contributing, you agree that your contributions will be licensed under the MIT License.