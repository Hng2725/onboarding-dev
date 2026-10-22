# Changelog

This project follows Semantic Versioning. `package.json`, `package-lock.json`, `privos-app.json` and this file must describe the same release.

## [2.17.18] - 2026-10-20

### Added

- Complete room-scoped PrivOS onboarding product for Admin and Learner roles.
- Manual member assignment with normal/advanced classification and pinned template versions.
- Immutable built-in PrivOS learning templates plus custom template drafts, file uploads and publishing.
- Required-material progress gate, recovery drafts, idempotent submissions and automatic multiple-choice scoring.
- Comment-only essay feedback, separate overall evaluation and exact `Đạt`/`Không đạt`/`Làm lại` conclusions.
- Responsive light/dark UI with free Ant Design icons and reduced-motion support.

### Security

- Fail-closed mapping from verified room/workspace roles; UI-supplied actor and room values are never trusted.
- Learner access is bound to the verified actor and sanitized DTOs hide answer keys and internal identifiers.
- Every onboarding record is room-scoped and sensitive write operations use idempotent operation IDs.

### Removed

- All legacy demo UI panels, demo backend tools, license examples, sample archives and stale Marketplace media.
