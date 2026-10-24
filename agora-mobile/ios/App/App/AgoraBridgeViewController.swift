import UIKit
import WebKit
import Capacitor

/// Capacitor's view controller with the bridge locked down to the bundled picker
/// and the user's saved Agora servers. Set as the custom class in Main.storyboard.
class AgoraBridgeViewController: CAPBridgeViewController {
    private let shell = AgoraShellPlugin()
    private var messageFilter: FilteringMessageHandler?
    private var uiDelegateProxy: AgoraUIDelegate?

    override open func capacitorDidLoad() {
        guard let bridge = bridge, let webView = webView,
              let delegationHandler = webView.navigationDelegate as? WebViewDelegationHandler else { return }
        bridge.registerPluginInstance(shell)

        // Capacitor's script handler accepts messages from any frame and origin. Put a filter in front of it.
        let contentController = webView.configuration.userContentController
        contentController.removeScriptMessageHandler(forName: "bridge")
        let filter = FilteringMessageHandler(target: delegationHandler, shell: shell, localURL: bridge.config.localURL)
        contentController.add(filter, name: "bridge")
        messageFilter = filter

        // window.AgoraNative. The script itself does nothing outside an https instance page,
        // and the filter refuses its calls from anywhere that is not a saved server.
        if let url = Bundle.main.url(forResource: "agora-native", withExtension: "js", subdirectory: "public"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            contentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            CAPLog.print("AgoraShell: public/agora-native.js missing; run npm run sync")
        }

        // Microphone for saved servers only (Capacitor grants every request).
        let proxy = AgoraUIDelegate(inner: webView.uiDelegate, shell: shell)
        webView.uiDelegate = proxy
        uiDelegateProxy = proxy

        // Swipe back from a server's first page returns to the server list.
        webView.allowsBackForwardNavigationGestures = true
    }
}

/// Forwards bridge messages to Capacitor only from the main frame of the picker or
/// a saved server, and from a saved server only what BridgePolicy allows.
final class FilteringMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WebViewDelegationHandler?
    private let shell: AgoraShellPlugin
    private let localOrigin: String

    init(target: WebViewDelegationHandler, shell: AgoraShellPlugin, localURL: URL) {
        self.target = target
        self.shell = shell
        let port = localURL.port.map { ":\($0)" } ?? ""
        self.localOrigin = "\(localURL.scheme?.lowercased() ?? "")://\(localURL.host?.lowercased() ?? "")\(port)"
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let target = target else { return }
        let origin = Origins.string(message.frameInfo.securityOrigin)
        if origin == localOrigin {
            target.userContentController(userContentController, didReceive: message)
            return
        }
        guard shell.savedOrigins.contains(origin), let body = message.body as? [String: Any] else { return }
        let type = body["type"] as? String ?? ""
        if type == "js.error" {
            target.userContentController(userContentController, didReceive: message)
            return
        }
        guard type == "message" else { return }
        let pluginId = body["pluginId"] as? String ?? ""
        let methodName = body["methodName"] as? String ?? ""
        let options = body["options"] as? [String: Any] ?? [:]
        if BridgePolicy.allowRemote(origin: origin, relayOrigin: shell.relayOrigin, pluginId: pluginId, methodName: methodName, options: options) {
            target.userContentController(userContentController, didReceive: message)
            return
        }
        CAPLog.print("AgoraShell: refused \(pluginId).\(methodName) from \(origin)")
        reject(body: body, in: message.webView)
    }

    /// Settle the page's promise instead of leaving it pending.
    private func reject(body: [String: Any], in webView: WKWebView?) {
        let result: [String: Any] = [
            "callbackId": body["callbackId"] as? String ?? "",
            "pluginId": body["pluginId"] as? String ?? "",
            "methodName": body["methodName"] as? String ?? "",
            "success": false,
            "error": ["message": "Not available to this page"]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.Capacitor.fromNative(\(json))")
    }
}

/// WKUIDelegate in front of Capacitor's: decides microphone requests, forwards the rest.
final class AgoraUIDelegate: NSObject, WKUIDelegate {
    private weak var inner: WKUIDelegate?
    private let shell: AgoraShellPlugin

    init(inner: WKUIDelegate?, shell: AgoraShellPlugin) {
        self.inner = inner
        self.shell = shell
    }

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return inner?.responds(to: aSelector) == true ? inner : nil
    }

    @available(iOS 15, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // iOS still asks the user once for the microphone (NSMicrophoneUsageDescription).
        if type == .microphone, frame.isMainFrame, shell.savedOrigins.contains(Origins.string(origin)) {
            decisionHandler(.grant)
        } else {
            decisionHandler(.deny)
        }
    }
}
