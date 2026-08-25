# iTantra — Master Implementation Plan Index

## Build Sequence

```
M1 (UI)
  └▶ M2 (STT) ─────────────────────────────┐
       └▶ M3 (TTS) ──────────────────────────┤
              └▶ M4 (Local Loop) ────────────┤
                     └▶ M5 (BLE) ───────────┤
                            └▶ M6 (Protocol)─┤
                                   └▶ M7 (Crypto)
                                          └▶ M8 (Reliability)
                                                 └▶ M9 (Wi-Fi Direct)  ← MVP complete here
                                                        └▶ M10 (Mesh)  ← Optional
                                                               └▶ M11 (All Languages)
```

---

## Milestone Plans

| Milestone | File | Description | Status |
|---|---|---|---|
| **M1** | [implementation_plan.md](implementation_plan.md) | React Native UI scaffold, all screens, mock data | 📋 Planned |
| **M2** | [milestone_2_stt.md](milestone_2_stt.md) | Offline STT via Vosk (EN/HI/BN) | 📋 Planned |
| **M3** | [milestone_3_tts.md](milestone_3_tts.md) | Offline TTS via Piper ONNX | 📋 Planned |
| **M4** | [milestone_4_local_loop.md](milestone_4_local_loop.md) | Local speech loop: STT → TTS on one device | 📋 Planned |
| **M5** | [milestone_5_ble.md](milestone_5_ble.md) | BLE GATT transport, device discovery, pairing | 📋 Planned |
| **M6** | [milestone_6_protocol.md](milestone_6_protocol.md) | Compact binary packet protocol | 📋 Planned |
| **M7** | [milestone_7_encryption.md](milestone_7_encryption.md) | AES-256-GCM + ECDH key exchange | 📋 Planned |
| **M8** | [milestone_8_reliability.md](milestone_8_reliability.md) | Retransmission, fragmentation, dedup, TTL | 📋 Planned |
| **M9** | [milestone_9_wifi_direct.md](milestone_9_wifi_direct.md) | Wi-Fi Direct transport + transport abstraction | 📋 Planned |
| **M10** | [milestone_10_mesh.md](milestone_10_mesh.md) | BLE mesh, store-and-forward (optional) | 📋 Optional |
| **M11** | [milestone_11_all_languages.md](milestone_11_all_languages.md) | All 10 Indian languages + benchmarking | 📋 Planned |

---

## Technology Stack Summary

### React Native JS Layer
| Component | Technology |
|---|---|
| Framework | React Native 0.79.x (New Architecture) |
| Navigation | React Navigation v6 |
| State | React Context + useReducer |
| QR Code display | react-native-qrcode-svg |
| QR Code scan | react-native-vision-camera |
| SVG (mesh UI) | react-native-svg |
| Testing | Jest |

### Kotlin Native Layer
| Component | Technology |
|---|---|
| Audio capture | Android AudioRecord |
| STT (EN/HI/BN/GU/MR/TA) | Vosk Android (Apache 2.0) |
| STT (KN/ML/TE/OR) | Whisper ONNX via ONNX Runtime |
| TTS (EN–TE) | Piper TTS via ONNX Runtime |
| TTS (OR) | eSpeak-NG |
| ONNX Runtime | com.microsoft.onnxruntime:onnxruntime-android |
| Compression | zstd-jni |
| Encryption | AES-256-GCM via javax.crypto (Conscrypt) |
| Key exchange | X25519 ECDH + HKDF-SHA256 |
| BLE | Android BluetoothLeScanner/Advertiser/GattClient/Server |
| Wi-Fi P2P | Android WifiP2pManager |
| Background | Android Foreground Service |
| Async | Kotlin Coroutines + Flow |
| Persistence | Android Room (mesh store-and-forward only) |

### ML Models
| Language | STT | Size | TTS | Size |
|---|---|---|---|---|
| English | Vosk small | 40 MB | Piper medium | 55 MB |
| Hindi | Vosk | 75 MB | Piper medium | 45 MB |
| Bengali | Vosk | 50 MB | Piper medium | 40 MB |
| Gujarati | Vosk | 55 MB | Piper medium | 42 MB |
| Marathi | Vosk | 50 MB | Piper medium | 44 MB |
| Kannada | Whisper small* | 466 MB* | Piper medium | 43 MB |
| Malayalam | Whisper small* | shared | Piper medium | 45 MB |
| Tamil | Vosk | 50 MB | Piper medium | 44 MB |
| Telugu | Whisper small* | shared | Piper medium | 46 MB |
| Odia | Whisper small* | shared | eSpeak-NG | 5 MB |

*Whisper model is shared across all 4 languages missing Vosk support.

---

## MVP Definition (End of M8)

The MVP is complete when:

- [x] Two Android phones communicate via BLE
- [x] STT runs offline (English + Hindi minimum)
- [x] TTS runs offline (English + Hindi minimum)
- [x] All messages are AES-256-GCM encrypted
- [x] Binary compact protocol (not JSON)
- [x] Retransmission + ACK/NACK working
- [x] Works with Internet fully disabled
- [x] No user account required
- [x] No external hardware required
- [x] Emergency ALERT messages prioritized

---

## Key Architecture Rules (from AGENTS.md)

> [!IMPORTANT]
> **Never violate these rules during implementation:**
> - React Native handles: UI, navigation, state, high-level service calls
> - Kotlin handles: AudioRecord, STT/TTS inference, BLE, Wi-Fi, crypto, compression
> - Never hardcode encryption keys
> - Never log raw transcripts or keys in production
> - Never use cloud STT, cloud TTS, Firebase, or any cloud service
> - compress → then encrypt (never the reverse)
> - Preserve all safety-critical words (negations, numbers, locations)
> - Never claim delivery without ACK

---

## Performance Budget

| Metric | Target |
|---|---|
| End-to-end latency (E2E) | < 3 seconds |
| STT latency (5-word utterance) | < 800 ms |
| TTS first audio | < 400 ms |
| BLE payload per message | < 200 bytes |
| App idle RAM | < 200 MB |
| App active RAM (STT+TTS loaded) | < 500 MB |
| APK size (English only) | < 150 MB |
| Peak CPU during inference | < 70% |

---

## Open Questions (Blocking M1 Start)

> [!IMPORTANT]
> **Approve before starting implementation:**

1. **STT Runtime** — Vosk (Apache 2.0, good Indian support) as primary, Whisper ONNX as fallback for missing languages?
2. **TTS Runtime** — Piper TTS (ONNX) as primary, Android built-in as fallback, eSpeak-NG for Odia?
3. **React Native version** — 0.79.x (New Architecture / TurboModules) or 0.74.x (stable)?
4. **Model distribution** — On-demand download from local server, or USB sideload for demo?
5. **Start with M1 immediately** or answer questions first?
