import Foundation
import UIKit
import WebKit
import Capacitor

/// Origin helpers. Mirrors normalizeOrigin() in src/lib/origin.ts and Origins.java.
enum Origins {
    /// "https://host[:port]" for an https URL, or nil. Default port dropped, host lower-cased.
    static func httpsOrigin(_ url: URL?) -> String? {
        guard let url = url, url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), !host.isEmpty, host != "localhost",
              url.user == nil, url.password == nil else { return nil }
        let port = url.port.flatMap { $0 == 443 ? nil : $0 }
        return "https://\(host)" + (port.map { ":\($0)" } ?? "")
    }

    static func httpsOrigin(_ string: String?) -> String? {
        guard let string = string else { return nil }
        return httpsOrigin(URL(string: string))
    }

    /// Scheme, host and port of a frame's security origin.
    static func string(_ origin: WKSecurityOrigin) -> String {
        let scheme = origin.protocol.lowercased()
        let defaultPort = origin.port == 0 || (scheme == "https" && origin.port == 443) || (scheme == "http" && origin.port == 80)
        return "\(scheme)://\(origin.host.lowercased())" + (defaultPort ? "" : ":\(origin.port)")
    }

    /// The saved servers, from the JSON the picker writes with Capacitor Preferences (src/lib/servers.ts).
    static func saved() -> Set<String> {
        guard let json = UserDefaults.standard.string(forKey: "CapacitorStorage.agora.servers"),
              let data = json.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        var origins = Set<String>()
        for entry in array {
            if let origin = entry["origin"] as? String, httpsOrigin(origin) == origin { origins.insert(origin) }
        }
        return origins
    }
}

/// Which native calls a saved instance page may make. Keep in step with BridgePolicy.java.
enum BridgePolicy {
    static let handleKeyPrefix = "agora.push."
    private static let pushMethods: Set<String> = ["checkPermissions", "requestPermissions", "register", "addListener", "removeListener", "removeAllListeners"]
    private static let pushEvents: Set<String> = ["registration", "registrationError", "pushNotificationActionPerformed"]
    private static let preferenceMethods: Set<String> = ["get", "set", "remove"]

    static func allowRemote(origin: String, relayOrigin: String?, pluginId: String, methodName: String, options: [String: Any]) -> Bool {
        switch pluginId {
        case "PushNotifications":
            guard pushMethods.contains(methodName) else { return false }
            return methodName != "addListener" || pushEvents.contains(options["eventName"] as? String ?? "")
        case "Device":
            return methodName == "getInfo"
        case "Preferences":
            return preferenceMethods.contains(methodName) && (options["key"] as? String) == handleKeyPrefix + origin
        case "CapacitorHttp":
            return methodName == "request" && isRelayUrl(options["url"] as? String, relayOrigin: relayOrigin)
        case "Console":
            return true
        default:
            return false
        }
    }

    static func isRelayUrl(_ string: String?, relayOrigin: String?) -> Bool {
        guard let string = string, let relayOrigin = relayOrigin,
              let components = URLComponents(string: string),
              Origins.httpsOrigin(string) == relayOrigin, components.fragment == nil else { return false }
        let path = components.percentEncodedPath
        if !path.hasPrefix("/v1/") || path.contains("/../") || path.contains("/./") || path.hasSuffix("/..") || path.lowercased().contains("%2e") {
            return false
        }
        return true
    }
}

extension Notification.Name {
    static let agoraShowServerList = Notification.Name("AgoraShowServerList")
}

/// The shell's native plugin: navigation lock, launch state and saved-server refresh.
/// Instance pages cannot call it (BridgePolicy); the bundled picker can.
@objc(AgoraShellPlugin)
public class AgoraShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgoraShellPlugin"
    public let jsName = "AgoraShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunchState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "serversChanged", returnType: CAPPluginReturnPromise)
    ]

    /// Set when the app was launched from the "Switch server" quick action.
    static var launchedForServerList = false

    private let lock = NSLock()
    private var autoOpenUsed = false
    private var saved: Set<String> = Origins.saved()

    var savedOrigins: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return saved
    }

    lazy var relayOrigin: String? = Origins.httpsOrigin(getConfig().getString("relayUrl"))

    override public func load() {
        if AgoraShellPlugin.launchedForServerList { autoOpenUsed = true }
        NotificationCenter.default.addObserver(self, selector: #selector(showServerList), name: .agoraShowServerList, object: nil)
    }

    @objc func getLaunchState(_ call: CAPPluginCall) {
        lock.lock()
        let autoOpen = !autoOpenUsed
        autoOpenUsed = true
        lock.unlock()
        call.resolve(["autoOpen": autoOpen])
    }

    @objc func serversChanged(_ call: CAPPluginCall) {
        let fresh = Origins.saved()
        lock.lock(); saved = fresh; lock.unlock()
        call.resolve()
    }

    @objc private func showServerList() {
        lock.lock(); autoOpenUsed = true; lock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let bridge = self?.bridge, let webView = bridge.webView else { return }
            webView.load(URLRequest(url: bridge.config.appStartServerURL))
        }
    }

    // MARK: Navigation lock

    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else { return nil }
        // Subframes (srcdoc canvases, embeds) never get the bridge; Capacitor's default handles them.
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { return nil }
        if ["about", "data", "blob"].contains(scheme) { return nil }

        if let local = bridge?.config.localURL, url.scheme == local.scheme, url.host == local.host { return NSNumber(value: false) }

        if let origin = Origins.httpsOrigin(url), savedOrigins.contains(origin) {
            if navigationAction.targetFrame == nil {
                // target=_blank on a saved server: keep it in the app instead of Safari.
                DispatchQueue.main.async { [weak self] in _ = self?.bridge?.webView?.load(navigationAction.request) }
                return NSNumber(value: true)
            }
            return NSNumber(value: false)
        }

        // Anything else (other sites, mailto:, tel:) goes to the system.
        DispatchQueue.main.async {
            if UIApplication.shared.applicationState == .active { UIApplication.shared.open(url) }
        }
        return NSNumber(value: true)
    }
}
