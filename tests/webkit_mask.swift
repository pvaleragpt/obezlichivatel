// Обезличить файл страницей в WebKit (как в Safari) и сохранить результат — для автопроверок.
//   swift tests/webkit_mask.swift <адрес или путь к странице> <входной файл> <выходной файл>
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
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 900))
let nav = Nav(); web.navigationDelegate = nav
if a[1].hasPrefix("http") { web.load(URLRequest(url: URL(string: a[1])!)) }
else { let u = URL(fileURLWithPath: a[1]); web.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent()) }
spin(15) { nav.loaded }
let input = URL(fileURLWithPath: a[2]), data = try! Data(contentsOf: input)
var result: String?
web.callAsyncJavaScript("""
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], name));
  document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  const wait = async (p, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !p()) await new Promise(r => setTimeout(r, 100)); };
  const err = () => document.getElementById('errors').innerText.trim();
  await wait(() => !document.getElementById('stepReview').hidden || err(), 120000);
  if (err()) return 'ERR ' + err();
  await wait(() => document.getElementById('aiCard').hidden || /готово|нашла|новых|недоступна|ярлык/.test(document.getElementById('aiStatus').innerText), 120000);
  const ai = document.getElementById('aiCard').hidden ? '' : document.getElementById('aiStatus').innerText;
  document.getElementById('btnApply').click();
  await wait(() => !document.getElementById('stepDone').hidden || err(), 120000);
  if (err()) return 'ERR ' + err();
  const buf = new Uint8Array(await (await fetch(document.getElementById('dlFile').href)).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
  const check = document.getElementById('checkNote').hidden ? '' : ' · ' + document.getElementById('checkNote').innerText.split(String.fromCharCode(10)).join(' ');
  return 'OK ' + ai.split(String.fromCharCode(10)).join(' ') + check + '|' + btoa(s);
""", arguments: ["b64": data.base64EncodedString(), "name": input.lastPathComponent], in: nil, in: .page) { r in
    if case .success(let v) = r { result = "\(v ?? "")" } else if case .failure(let e) = r { result = "ERR \(e)" }
}
spin(300) { result != nil }
guard let res = result, res.hasPrefix("OK"), let bar = res.firstIndex(of: "|") else { print(result ?? "нет ответа"); exit(1) }
try! Data(base64Encoded: String(res[res.index(after: bar)...]))!.write(to: URL(fileURLWithPath: a[3]))
print(res[..<bar])
