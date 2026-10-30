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
/// a saved server, and from a saved server only what BridgePolicy allows. AgoraShell's
/// push calls from a saved server run natively for that frame's security origin.
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
        if BridgePolicy.allowRemote(origin: origin, pluginId: pluginId, methodName: methodName, options: options) {
            if pluginId == "AgoraShell" {
                // Push registration: run natively for the origin WebKit reported, never one from the page.
                let webView = message.webView
                shell.runPageCall(methodName: methodName, origin: origin, options: options) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let data):
                            FilteringMessageHandler.settle(body: body, success: true, payload: data, origin: origin, in: webView)
                        case .failure(let failure):
                            FilteringMessageHandler.settle(body: body, success: false, payload: ["message": failure.message], origin: origin, in: webView)
                        }
                    }
                }
                return
            }
            target.userContentController(userContentController, didReceive: message)
            return
        }
        CAPLog.print("AgoraShell: refused \(pluginId).\(methodName) from \(origin)")
        FilteringMessageHandler.settle(body: body, success: false, payload: ["message": "Not available to this page"], origin: origin, in: message.webView)
    }

    /// Settle the page's promise, only while the page shown is still on the origin that called
    /// (a push handle must never reach another server's page). Main thread.
    private static func settle(body: [String: Any], success: Bool, payload: [String: Any], origin: String, in webView: WKWebView?) {
        guard let webView = webView, Origins.httpsOrigin(webView.url) == origin else { return }
        var result: [String: Any] = [
            "callbackId": body["callbackId"] as? String ?? "",
            "pluginId": body["pluginId"] as? String ?? "",
            "methodName": body["methodName"] as? String ?? "",
            "success": success
        ]
        result[success ? "data" : "error"] = payload
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.Capacitor.fromNative(\(json))")
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
        // Main frame of the saved server shown: the requesting origin must be the top-level page's.
        let requester = Origins.string(origin)
        if type == .microphone, frame.isMainFrame, Origins.httpsOrigin(webView.url) == requester,
           shell.savedOrigins.contains(requester) {
            decisionHandler(.grant)
        } else {
            decisionHandler(.deny)
        }
    }
}
