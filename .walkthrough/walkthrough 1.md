# Milestone 1 — Walkthrough

I have scaffolded the complete React Native UI architecture as specified in Milestone 1.

## Accomplished
1. Initialized the React Native `0.87` project with TypeScript support.
2. Built the complete `src/` directory hierarchy (`screens/`, `components/`, `navigation/`, `hooks/`, `services/`, `native/`, `state/`, etc.).
3. Implemented standard React Navigation with `native-stack`.
4. Constructed all UI screens with a stunning, high-contrast dark theme designed for emergency field use:
   - **[HomeScreen](file:///d:/projects/iTantra/src/screens/HomeScreen.tsx)**: Main dashboard with a prominent Push-to-Talk button and quick navigation tiles.
   - **[ChatScreen](file:///d:/projects/iTantra/src/screens/ChatScreen.tsx)**: Message history with distinct visual bubbles for `NORMAL` (neon green) and `ALERT` (deep red).
   - **[ConnectScreen](file:///d:/projects/iTantra/src/screens/ConnectScreen.tsx)**: Discovery UI mimicking active BLE/Wi-Fi scanning with signal strength indicators.
   - **[LanguageScreen](file:///d:/projects/iTantra/src/screens/LanguageScreen.tsx)**: 10-language selector highlighting installed/active models.
   - **[AlertScreen](file:///d:/projects/iTantra/src/screens/AlertScreen.tsx)**: A high-visibility full-screen emergency alert modal with explicit acknowledgment button.
   - **[BenchmarkScreen](file:///d:/projects/iTantra/src/screens/BenchmarkScreen.tsx)**: Performance dashboard to track latency, RTF, and payload sizes.
   - **[SettingsScreen](file:///d:/projects/iTantra/src/screens/SettingsScreen.tsx)**: UI for identity and pairing codes.
5. Created mock Native Module wrappers in `src/native/index.js` to simulate calls to STT, TTS, and BLE without crashing the UI.

## How to Test
1. Connect a physical Android device or start an emulator.
2. Run `npm install` (this is running in the background right now).
3. Run `npx react-native run-android`.
4. Navigate through all screens to verify the UI.

Next up would be **Milestone 2**: integrating the Vosk STT engine in Kotlin!
