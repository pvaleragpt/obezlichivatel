// Снимок страницы в WebKit (как в Safari): swift tests/webkit_shot.swift <страница> <png> <ширина> <высота> [файл] [done]
// С файлом — «перетаскивает» его и снимает экран проверки; с «done» — ещё и экран результата.
import Foundation
import WebKit

final class Nav: NSObject, WKNavigationDelegate {
    var loaded = false
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { loaded = true }
}
func spin(_ s: Double, until done: () -> Bool) {
    let end = Date().addingTimeInterval(s)
    while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
}

let a = CommandLine.arguments
let page = URL(fileURLWithPath: a[1]).standardizedFileURL
let out = URL(fileURLWithPath: a[2])
let width = Double(a[3]) ?? 1280, height = Double(a[4]) ?? 900
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))
let nav = Nav(); web.navigationDelegate = nav
if a[1].hasPrefix("http") { web.load(URLRequest(url: URL(string: a[1])!)) } else { web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent()) }
spin(15) { nav.loaded }

if a.count > 5, let data = try? Data(contentsOf: URL(fileURLWithPath: a[5])) {
    var done = false
    let toDone = a.count > 6 && a[6] == "done"
    web.callAsyncJavaScript("""
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], name));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const wait = async (p, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !p()) await new Promise(r => setTimeout(r, 100)); };
      await wait(() => !document.getElementById('stepReview').hidden, 30000);
      if (toDone) { document.getElementById('btnApply').click(); await wait(() => !document.getElementById('stepDone').hidden, 30000); }
      return 1;
    """, arguments: ["b64": data.base64EncodedString(), "name": URL(fileURLWithPath: a[5]).lastPathComponent, "toDone": toDone],
       in: nil, in: .page) { _ in done = true }
    spin(60) { done }
    spin(0.5) { false }
}

let cfg = WKSnapshotConfiguration()
cfg.rect = NSRect(x: 0, y: 0, width: width, height: height)
var finished = false
web.takeSnapshot(with: cfg) { img, err in
    if let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: out) } else { print("снимок не удался: \(String(describing: err))") }
    finished = true
}
spin(10) { finished }
print(out.path)
