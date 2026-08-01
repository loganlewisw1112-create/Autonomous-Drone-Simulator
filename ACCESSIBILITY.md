# Accessibility status

Last reviewed: 2026-07-27

The project aims to support keyboard, mouse, touch, and common desktop/mobile
viewports. It does **not** currently claim WCAG 2.1/2.2 conformance, Section
508 compliance, or an independent accessibility certification.

## Current design support

- Mobile and desktop layouts provide separate sizing and interaction surfaces.
- Important mission states use text and icons in addition to map position.
- Native buttons, inputs, labels, headings, and dialogs are used in many core
  flows.
- Reduced-motion and high-contrast behavior can inherit browser/OS settings
  where components use standard CSS behavior.

These are design intentions, not audit results. A tactical map, dense telemetry
panels, charts, drag-only waypoint interaction, rapidly updating status, focus
management, and color-coded warnings remain high-risk areas.

## Required stable-release assessment

Test the Windows, Mobile, Classroom instructor, and Classroom student surfaces
with:

- keyboard-only navigation, visible focus, logical order, skip paths, dialogs,
  drawers, menus, route editing, mission controls, and error recovery;
- Windows Narrator with Edge and NVDA with Firefox or Chrome;
- browser zoom to 200% and reflow at 320 CSS pixels;
- OS high contrast/forced colors, reduced motion, and text spacing overrides;
- contrast checks for text, controls, charts, map overlays, warnings, selected
  state, and focus indicators;
- touch targets, orientation changes, and non-drag alternatives;
- accessible names, relationships, live-region frequency, table semantics,
  validation messages, and status announcements.

The test record must name release SHA, target, browser/assistive-technology
versions, failures, workarounds, owner, and retest result. Automated checks may
supplement but cannot replace the manual assessment.

## Known gaps until tested

- Map-based spatial information may not have an equivalent linear description.
- Dragging waypoints may lack a complete keyboard alternative.
- Rapid telemetry and classroom focus updates may be noisy or silent to screen
  readers.
- Charts and thermal/route overlays may depend too heavily on color.
- Dense fixed desktop panels may not reflow cleanly at high zoom.
- Focus restoration after modal, drawer, and account transitions is not
  independently verified.

Institution-facing materials must describe the tested support truthfully and
provide a contact/alternative workflow for an accessibility blocker.
