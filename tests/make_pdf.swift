// PDF с текстовым слоем из HTML (WebKit) — для проверки чтения PDF.
//   swift tests/make_pdf.swift <входной.html> <выходной.pdf>
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
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 1100))
let nav = Nav(); web.navigationDelegate = nav
let u = URL(fileURLWithPath: a[1])
web.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent())
spin(15) { nav.loaded }
var done = false
web.createPDF(configuration: WKPDFConfiguration()) { r in
    if case .success(let d) = r { try! d.write(to: URL(fileURLWithPath: a[2])) } else { print("ошибка PDF") }
    done = true
}
spin(30) { done }
print(a[2])
