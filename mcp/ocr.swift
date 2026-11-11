// Обезличиватель — распознавание текста на картинке встроенным в macOS Apple Vision (без интернета).
//   ocr <картинка> → JSON: {"width", "height", "lines": [{"text", "x", "y", "w", "h", "conf"}]}
// Координаты — доли размера картинки, начало в левом нижнем углу (как у Vision).
// Собирается установщиком: swiftc -O ocr.swift -o ocr (нужна macOS 13+ — в ней Vision знает русский).
import Foundation
import ImageIO
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count > 1 else { fail("ocr <картинка>") }
let url = URL(fileURLWithPath: args[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("не удалось открыть картинку") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ru-RU", "en-US"]
do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("распознавание не удалось: \(error.localizedDescription)")
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let best = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append(["text": best.string, "x": box.minX, "y": box.minY, "w": box.width, "h": box.height,
                  "conf": Double(best.confidence)])
}
let result: [String: Any] = ["width": image.width, "height": image.height, "lines": lines]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result))
