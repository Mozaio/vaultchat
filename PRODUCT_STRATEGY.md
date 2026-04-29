# VaultChat Product Strategy

VaultChat should be positioned as a privacy-first messenger for people who want strong encryption without accepting surveillance-style account recovery.

## Identity and Registration

- Default path: username, password, local key backup.
- Optional authenticity path: recovery email. The server stores only an HMAC hash, not the clear email address.
- Recommended production mode: invite-only registration until abuse controls, payment, and moderation policies are mature.
- New-device login must continue to require an encrypted identity backup. Email must not become a key-recovery backdoor.

## Monetization

Start with plans that sell reliability and operations, not access to message content.

- Personal: free, private chats, groups, encrypted backup export.
- Pro: monthly subscription for more devices, longer encrypted mailbox retention, priority support.
- Team: per-seat subscription for invite management, admin policies, and compliance metadata reports without message plaintext.

Do not monetize by scanning, ads, public directories, or behavioral profiling.

## Product Roadmap

1. Add payment provider integration with privacy-preserving customer IDs.
2. Add invite management for Team accounts.
3. Add account recovery flow that proves email ownership without exposing keys.
4. Add device list and remote device revoke.
5. Add onboarding checklist after registration: backup exported, safety number explained, notifications configured.
6. Add delivery-state diagnostics for groups: live, queued, decrypted, key pending.
7. Add abuse controls: username rate limits, report flow based on user-supplied message export, server-side invite throttling.

## UI Direction

- Signal: strong keyboard shortcuts, clear privacy copy, safety-number trust.
- Telegram: fast sidebar, compact chat list, clear media/reply UX.
- WhatsApp Web: low-friction navigation and familiar composer.
- Discord: grouped messages, hover actions, reliable group context.

VaultChat should feel calm, dense, and serious. Avoid marketing-heavy screens inside the product.
