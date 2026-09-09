# iTantra UI Redesign Instructions

## Objective

Redesign the current iTantra UI to make it **communication-first**, clean, intuitive, and suitable for the final user-facing application.

The current UI is a useful development/MVP dashboard. **Do not remove any existing functionality or buttons.** Every current button/feature must remain accessible.

You may:
- Rename buttons/cards.
- Rearrange buttons/cards.
- Change their visual hierarchy.
- Group related features.
- Move developer/testing features into a Settings or Diagnostics section.
- Change layouts, spacing, typography, icons, and visual styling.
- Change navigation structure as long as every existing feature remains accessible.

You must NOT:
- Delete any existing button or feature.
- Remove functionality just because it is primarily for development.
- Remove Emergency, Performance, Local Loop, Speech Diagnostics, Messages, Discover, Language, Settings, or BLE Voice Mode.
- Break existing navigation or functionality.

---

## Current Features That Must Be Preserved

The current home screen contains:

1. **BLE Voice Mode**
   - Current state: ON/OFF
   - Connection state: connected/not connected
   - May be renamed to something clearer such as **iTantra Link**.

2. **Messages**
   - Secure chat/message history.

3. **Discover**
   - BLE device discovery/pairing.

4. **Language**
   - Current language selection.

5. **Settings**
   - Profile and preferences.

6. **Emergency**
   - Emergency alert functionality.
   - Must remain easily discoverable and must not be deleted.

7. **Performance**
   - Metrics/dashboard.

8. **Local Loop**
   - Local speech-loop testing.

9. **Speech Diagnostics**
   - Experimental speech/STT diagnostics, including sherpa-onnx related testing.

10. **HOLD TO SPEAK**
    - Primary Push-To-Talk control.
    - Must remain prominent.

---

# Design Direction

## 1. Make iTantra Communication-First

The primary purpose of the application should immediately be obvious.

The home screen should prioritize:

1. Connection status
2. Language pair
3. Push-To-Talk
4. Recent communication/message state
5. Messages
6. Discover/devices

Developer/testing functions can have lower visual priority but must remain accessible.

The application should feel more like:

> **Offline translator + walkie-talkie + secure communication device**

and less like a collection of development test screens.

---

# Recommended Home Screen

A suggested structure:

```text
┌─────────────────────────────┐
│ iTantra                 ⚙️  │
│                             │
│ 🟢 READY / CONNECTED        │
│                             │
│ Connected to                │
│ ┌─────────────────────────┐ │
│ │ 📡 Device               │ │
│ │    Ready to communicate │ │
│ └─────────────────────────┘ │
│                             │
│      Bengali  ⇄  Hindi      │
│                             │
│        ┌───────────┐        │
│        │    🎙     │        │
│        │           │        │
│        │ HOLD TO   │        │
│        │   SPEAK   │        │
│        └───────────┘        │
│                             │
│        Last message...      │
│                             │
│ ─────────────────────────── │
│                             │
│  💬 Messages    📡 Devices  │
└─────────────────────────────┘
```

This is only a design direction. The implementation can use a different layout if it provides a better UX.

---

# Push-To-Talk State Design

The existing **HOLD TO SPEAK** button is important and should remain the primary action.

The button should communicate the current processing state.

### Idle

```text
🟢
HOLD TO SPEAK
```

### While pressed

```text
🔴
LISTENING...
Release to send
```

### Speech processing

```text
🟡
PROCESSING...
```

### Sending

```text
🔵
SENDING...
```

### Receiving

```text
🟣
RECEIVING...
```

### Error

Clearly show an error state without hiding the rest of the application.

---

# Language UI

Language selection should be more visible than it is currently because language is fundamental to iTantra.

Prefer a language-pair presentation such as:

```text
🇮🇳 Bengali
     ⇅
🇮🇳 Hindi
```

The user should be able to tap the language pair to open the language selector.

The existing **Language** feature must remain accessible.

Do not assume that only English/Hindi/Bengali will be supported. The UI should scale to all supported languages.

---

# BLE Connection UI

The current **BLE Voice Mode** can be renamed if desired.

A better user-facing name could be:

> **iTantra Link**

or

> **Connection**

The UI should clearly communicate:

```text
🟢 Connected
🟡 Connecting...
🔴 Disconnected
```

Avoid exposing implementation details such as:

- GATT
- characteristic UUIDs
- Central/peripheral
- packet structure
- MTU

Those belong in Diagnostics.

However, the existing BLE Voice Mode functionality must remain.

---

# Messages

Messages should remain accessible from the main navigation.

The conversation can display:

```text
You

আমি বাড়ি যাচ্ছি

Translation

I am going home. 🔊
```

The UI should support the project's speech-to-text, translation, transmission, and text-to-speech flow.

Do not make it look exactly like WhatsApp. It should feel like iTantra's own communication interface.

---

# Discover

Keep **Discover** accessible.

It can be renamed to:

> **Devices**

or

> **Nearby Devices**

Recommended contents:

- Nearby iTantra devices
- Connection state
- Pair/connect action
- Scan
- Current connected device

Do not remove the Discover functionality.

---

# Emergency

**Emergency MUST remain available.**

It can be visually separated from normal communication features.

Possible placement:

```text
More / Safety
    ↓
🚨 Emergency
```

or a clearly visible Emergency action on the main screen.

If the action can trigger a real emergency alert, use appropriate confirmation to reduce accidental activation.

Do not hide it so deeply that users cannot find it.

---

# Developer / Diagnostic Features

The following features must remain:

- Performance
- Local Loop
- Speech Diagnostics

They can be moved away from the primary home screen.

Recommended structure:

```text
Settings
   │
   ├── Profile & Preferences
   ├── Language
   ├── Emergency
   │
   └── Diagnostics / Developer
          ├── Performance
          ├── Local Loop
          └── Speech Diagnostics
```

This is a **rearrangement**, not deletion.

These screens are important during development and testing.

---

# Diagnostics

A possible diagnostics area:

```text
Diagnostics

BLE
  Connection       Connected
  MTU              512
  RSSI             -58 dBm

Speech
  STT              ✓
  TTS              ✓

Last Packet
  Type             TEXT
  Sequence         142
  Payload          38 B
  Encryption       ✓
```

The exact metrics can remain based on the existing implementation.

Do not remove useful existing diagnostics just to simplify the UI.

---

# Visual Style

The existing dark theme should generally be retained because it already fits iTantra well.

Recommended visual direction:

- Dark background.
- Green as the primary iTantra/accent color.
- Red reserved for Emergency/danger states.
- High contrast.
- Large, easily tappable controls.
- Rounded cards where appropriate.
- Clear hierarchy.
- Minimal unnecessary decoration.
- Consistent spacing.
- Clear status indicators.

The UI should work well on smaller Android phones as well as larger screens.

---

# Navigation

A possible navigation model:

```text
                         iTantra
                            │
             ┌──────────────┼──────────────┐
             │              │              │
           Radio          Messages       Devices
             │
             └──────────── Settings
                              │
                   ┌──────────┴──────────┐
                   │                     │
              Preferences           Diagnostics
                                         │
                              ┌──────────┼──────────┐
                              │          │          │
                         Performance  Local Loop  Speech Diag
```

This is a recommendation, not a rigid requirement.

The existing buttons/features must remain accessible somewhere.

---

# Important Constraint

## DO NOT REMOVE ANY BUTTONS

This is the most important requirement.

The redesign is allowed to:

- Rename.
- Rearrange.
- Reorganize.
- Group.
- Change navigation.
- Change visual prominence.
- Move development tools into Diagnostics.
- Move settings-related controls into Settings.
- Improve icons and labels.

The redesign is NOT allowed to:

- Delete buttons.
- Delete features.
- Delete screens.
- Remove functionality.
- Make a feature inaccessible.

Every current feature must have an obvious destination after the redesign.

---

# Existing → Suggested User-Facing Organization

| Current | Suggested |
|---|---|
| BLE Voice Mode | iTantra Link / Connection |
| Messages | Messages |
| Discover | Devices / Nearby Devices |
| Language | Language / Language Pair |
| Settings | Settings |
| Emergency | Emergency / Safety |
| Performance | Diagnostics → Performance |
| Local Loop | Diagnostics → Local Loop |
| Speech Diag | Diagnostics → Speech Diagnostics |
| HOLD TO SPEAK | HOLD TO SPEAK / Primary PTT |

Again, these are renames/rearrangements only. **Nothing is to be removed.**

---

# Implementation Principle

Keep the existing native/backend architecture unchanged unless a UI change genuinely requires an interface update.

The UI redesign should primarily change:

- React Native screens.
- Component layout.
- Navigation.
- Styling.
- State presentation.

Do not unnecessarily modify the BLE, STT, TTS, binary protocol, or native Android implementation.

The final UI should make the existing iTantra functionality easier to understand and use.

---

# Success Criteria

The redesign is successful if:

- A new user immediately understands that iTantra is a communication device.
- The PTT button is the primary action.
- Connection status is obvious.
- Language direction is obvious.
- Messages and Devices are easy to reach.
- Emergency remains accessible.
- Performance, Local Loop, and Speech Diagnostics remain available.
- No existing feature/button has been removed.
- Developer functionality is organized rather than deleted.
- The UI remains usable on Android phones with smaller displays.
- The dark/green iTantra identity is preserved.
