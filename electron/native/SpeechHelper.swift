// Apple Speech dictation for Blackout's voice messages.
// Speaks JSON lines on stdout: ready / partial / final / error.
// stdin commands: "start", "stop", "quit".
import Foundation
import AVFoundation
import Speech

final class Voice: NSObject, SFSpeechRecognizerDelegate {
  private let locale: String
  private let engine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var listening = false
  private var stopPending = false
  private var done = false
  private var tapOn = false
  private var lastText = ""

  init(_ locale: String) {
    self.locale = locale
    super.init()
  }

  private func emit(_ type: String, text: String = "", message: String = "") {
    var obj: [String: Any] = ["type": type]
    if !text.isEmpty { obj["text"] = text }
    if !message.isEmpty { obj["message"] = message }
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }

  func start() {
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      DispatchQueue.main.async { self?.begin(status) }
    }
  }

  private func begin(_ status: SFSpeechRecognizerAuthorizationStatus) {
    guard status == .authorized else {
      emit("error", message: "Speech recognition permission denied")
      done = true
      return
    }
    let rec = SFSpeechRecognizer(locale: Locale(identifier: locale))
    guard let rec, rec.isAvailable else {
      emit("error", message: "Apple Speech is unavailable for \(locale)")
      done = true
      return
    }
    rec.delegate = self
    recognizer = rec

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    if #available(macOS 11.0, *) {
      // Siri's on-device engine where the Mac supports it; Apple's hosted
      // recognition otherwise. Never a third-party service.
      req.requiresOnDeviceRecognition = rec.supportsOnDeviceRecognition
    }
    request = req

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }
    tapOn = true
    do {
      engine.prepare()
      try engine.start()
    } catch {
      emit("error", message: "Mic failed: \(error.localizedDescription)")
      cleanup()
      return
    }

    listening = true
    task = rec.recognitionTask(with: req) { [weak self] result, error in
      guard let self, !self.done else { return }
      if let result {
        let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { self.lastText = text }
        if result.isFinal {
          self.emit("final", text: self.lastText)
          self.cleanup()
          return
        }
        self.emit("partial", text: text)
      }
      if let error {
        // endAudio() often ends with error 203 but a usable transcript.
        if !self.listening, !self.lastText.isEmpty {
          self.emit("final", text: self.lastText)
        } else {
          self.emit("error", message: error.localizedDescription)
        }
        self.cleanup()
      }
    }
    emit("ready")
    if stopPending { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.stop() } }
  }

  func stop() {
    if !listening && !done { stopPending = true; return }
    guard listening, !done else { return }
    stopPending = false
    listening = false
    engine.stop()
    if tapOn { engine.inputNode.removeTap(onBus: 0); tapOn = false }
    request?.endAudio()
  }

  func cancel() {
    done = true
    cleanup()
  }

  private func cleanup() {
    done = true
    listening = false
    if tapOn { engine.inputNode.removeTap(onBus: 0); tapOn = false }
    engine.stop()
    task?.cancel()
    task = nil
    request = nil
  }
}

let args = CommandLine.arguments
let voice = Voice(args.count > 1 ? args[1] : "en-US")

DispatchQueue.global(qos: .utility).async {
  while let line = readLine(strippingNewline: true) {
    let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
    DispatchQueue.main.async {
      switch cmd {
      case "start": voice.start()
      case "stop": voice.stop()
      case "quit": exit(0)
      default: break
      }
    }
  }
  exit(0)
}

RunLoop.main.run()
