// Проверка страницы в настоящем WebKit (движок Safari), открытой из файла — как через ярлык.
//
//   swift tests/webkit_check.swift dist/Обезличиватель.html <файл.docx|xlsx|txt> [ещё файлы…]
//
// Для каждого файла: «перетаскивает» его на страницу, ждёт экран проверки, нажимает
// «Скрыть» и печатает, что получилось. Код выхода 1 — если хоть один файл не прошёл.
import Foundation
import WebKit

final class Runner: NSObject, WKNavigationDelegate {
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 900))
    var loaded = false
    override init() { super.init(); web.navigationDelegate = self }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { loaded = true }
}

func spin(_ seconds: Double, until done: () -> Bool) {
    let end = Date().addingTimeInterval(seconds)
    while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("нужно: страница и файлы"); exit(2) }
let page = URL(fileURLWithPath: args[1]).standardizedFileURL
let runner = Runner()
if args[1].hasPrefix("http") { runner.web.load(URLRequest(url: URL(string: args[1])!)) } else { runner.web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent()) }
spin(15) { runner.loaded }
guard runner.loaded else { print("страница не загрузилась"); exit(1) }

let script = """
const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const dt = new DataTransfer(); dt.items.add(new File([bytes], name));
document.querySelector('[data-tab=hide]').click();
document.getElementById('btnBack') && !document.getElementById('stepReview').hidden && document.getElementById('btnBack').click();
document.getElementById('stepDone').hidden || document.getElementById('btnAgain').click();
document.getElementById('errors').innerHTML = '';
document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
const wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !pred()) await new Promise(r => setTimeout(r, 100)); };
const err = () => document.getElementById('errors').innerText.trim();
await wait(() => !document.getElementById('stepReview').hidden || err(), 30000);
if (err()) return 'ОШИБКА на проверке: ' + err();
if (document.getElementById('stepReview').hidden) return 'ОШИБКА: экран проверки не появился';
await wait(() => document.getElementById('aiCard').hidden || /нашла|новых|недоступна|ярлык/.test(document.getElementById('aiStatus').innerText), 30000);
const aiText = document.getElementById('aiCard').hidden ? 'ИИ выкл' : document.getElementById('aiStatus').innerText.split(String.fromCharCode(10)).join(' ');
const summary = document.getElementById('applySummary').innerText;
document.getElementById('btnApply').click();
await wait(() => !document.getElementById('stepDone').hidden || err(), 30000);
if (err()) return 'ОШИБКА при записи: ' + err();
const a = document.getElementById('dlFile');
const size = a.href ? (await (await fetch(a.href)).blob()).size : 0;
return 'OK · ' + aiText + ' · ' + summary + ' · ' + document.getElementById('doneTitle').innerText + ' · файл ' + (a.hidden ? 'текстом' : size + ' байт');
"""

var failed = false
for path in args.dropFirst(2) {
    let url = URL(fileURLWithPath: path)
    guard let data = try? Data(contentsOf: url) else { print("\(url.lastPathComponent): не прочитан"); failed = true; continue }
    var result: String?
    runner.web.callAsyncJavaScript(script, arguments: ["b64": data.base64EncodedString(), "name": url.lastPathComponent],
                                   in: nil, in: .page) { r in
        switch r {
        case .success(let v): result = "\(v ?? "nil")"
        case .failure(let e): result = "ОШИБКА JS: \(e)"
        }
    }
    spin(70) { result != nil }
    let line = result ?? "ОШИБКА: нет ответа за 70 с"
    if !line.hasPrefix("OK") { failed = true }
    print("\(url.lastPathComponent): \(line)")
}
exit(failed ? 1 : 0)
