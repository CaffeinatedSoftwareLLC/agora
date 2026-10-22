# Android keyboard check (#196)

The app viewport opts into `interactive-widget=resizes-content`. Chrome on Android
then resizes both the layout and visual viewports when the keyboard opens. The
existing `.app-shell` and body `100dvh` heights follow that smaller viewport; the
flex message feed can shrink while the composer keeps its height. Safe-area
padding and the `100vh` fallback stay in place.

Reference: [Chrome's viewport resize behavior](https://developer.chrome.com/blog/viewport-resize-behavior/).

## Manual check (about 2 minutes)

Use Chrome on a real Android phone, with the normal docked software keyboard.

1. Open a channel, tap its message box, and type a sentence. The entire text line
   and Send button must stay above the keyboard.
2. Add four lines. The draft and caret must remain visible; extra text scrolls
   inside the composer rather than behind the keyboard.
3. Dismiss and reopen the keyboard. The feed must regain its height without a
   blank gap, and the draft must be preserved.
4. Repeat in a thread reply box, then in landscape orientation.

Playwright's `pixel-7` project uses desktop Chromium device emulation: it sets
viewport, user agent and touch parameters, but does not open an Android software
keyboard. Resizing that emulated viewport checks flex layout only; it cannot
verify that Chrome honors this keyboard policy. Record the real-device result
before calling the keyboard issue verified.

This setting targets the reported Android Chrome behavior. It does not establish
keyboard behavior for iOS Safari or floating keyboards.
