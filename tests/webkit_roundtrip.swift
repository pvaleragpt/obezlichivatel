// Туда и обратно в WebKit (как в Safari): страница скрывает данные в файле, затем вкладка «Вернуть данные»
// возвращает их по ключу. Сравнение текста — tests/compare_text.py.
//   swift tests/webkit_roundtrip.swift <страница> <входной файл> <обезличенный> <восстановленный>
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
  const $ = id => document.getElementById(id);
  const wait = async (p, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !p()) await new Promise(r => setTimeout(r, 100)); };
  const err = () => $('errors').innerText.trim();
  const b64of = async href => {
    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return btoa(s);
  };
  const put = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); };
  const fast = document.querySelector('.mtile[data-mode=fast]'); if (fast) fast.click();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], name));
  $('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await wait(() => !$('stepReview').hidden || err(), 120000);
  if (err()) return 'ERR ' + err();
  $('btnApply').click();
  await wait(() => !$('stepDone').hidden || err(), 120000);
  if (err()) return 'ERR ' + err();
  const masked = await b64of($('dlFile').href);
  const keyText = await (await fetch($('dlKey').href)).text();
  const check = $('checkNote').hidden ? '' : $('checkNote').innerText.split(String.fromCharCode(10)).join(' ');
  document.querySelector('[data-tab=restore]').click();
  put($('rKey'), new File([keyText], 'ключ.json', { type: 'application/json' }));
  put($('rFile'), new File([Uint8Array.from(atob(masked), c => c.charCodeAt(0))], $('dlFile').download));
  await new Promise(r => setTimeout(r, 300));
  $('btnRestore').click();
  await wait(() => !$('dlR').hidden, 120000);
  if ($('dlR').hidden) return 'ERR возврат не завершился: ' + $('rCount').innerText;
  const restored = await b64of($('dlR').href);
  return 'OK ' + check + ' · возврат ' + $('rCount').innerText + '|' + masked + '|' + restored;
""", arguments: ["b64": data.base64EncodedString(), "name": input.lastPathComponent], in: nil, in: .page) { r in
    if case .success(let v) = r { result = "\(v ?? "")" } else if case .failure(let e) = r { result = "ERR \(e)" }
}
spin(300) { result != nil }
guard let res = result, res.hasPrefix("OK") else { print(result ?? "нет ответа"); exit(1) }
let parts = res.split(separator: "|", omittingEmptySubsequences: false)
try! Data(base64Encoded: String(parts[1]))!.write(to: URL(fileURLWithPath: a[3]))
try! Data(base64Encoded: String(parts[2]))!.write(to: URL(fileURLWithPath: a[4]))
print(parts[0])
