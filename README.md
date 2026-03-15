# Bhavya Mittal — Portfolio

Personal portfolio site. Minimal, no framework, no build step — just HTML, CSS, and vanilla JS.

**Live:** [bhavyamittal.com](https://bhavyamittal.com)

---

## Structure

```
index.html        Homepage
wipe-it.html      Case study — Wipe It (interaction design)
sip-happens.html  Case study — SIP Happens (product design)
README.md
```

Each page is fully self-contained. No dependencies, no bundler, no node_modules.

---

## Design system

| Token | Value |
|-------|-------|
| Background | `#f7f6f2` |
| Foreground | `#3a3a3a` |
| Muted | `#9a9a9a` |
| Border | `#e8e5e0` |
| Accent | `#3b6fce` |
| Serif | Noto Serif (Google Fonts) |
| Sans | System font stack |
| Base size | 15px |
| Column width | 560px |

---

## Case studies

### Wipe It — 2025
Gesture-based text erasure for mobile. A scrub gesture that clears a text field the way a hand erases pencil on paper. Built as a functional HTML/JS prototype with canvas drawing, haptics, and synthesized audio.

### SIP Happens — 2026
Rethinking the SIP calculator as an honest planning tool. Helps first-time investors explore possibilities, understand trade-offs, and make decisions with realistic expectations — instead of just simulating numbers.

---

## Deployment

Hosted on Vercel. To deploy manually, drag all HTML files to the Deploys tab at [vercel.com](https://vercel.com).

To auto-deploy on push, connect this repo to Vercel via Import from Git.

---

## Editing

There is no build step. Edit HTML files directly and push. The files are authored to stay under ~30KB each so they remain readable and fast.

A `build.py` and `template.html` exist in the repo as authoring utilities for regenerating `index.html` with the favicon injected at build time — these are optional and not required for deployment.
