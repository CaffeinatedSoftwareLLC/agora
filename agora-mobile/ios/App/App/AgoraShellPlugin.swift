import Foundation
import UIKit
import WebKit
import CryptoKit
import UserNotifications
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

/// Which native calls a saved instance page may make. Push registration runs in native
/// code (AgoraShell.registerPush), so pages never see the device token and cannot reach
/// the relay or Preferences themselves.
///
/// Keep remoteCalls and remoteEvents identical to BridgePolicy.java:
/// test/consistency.test.ts compares the two lists.
enum BridgePolicy {
    static let handleKeyPrefix = "agora.push."

    /// Every call an instance page may make, as "pluginId.methodName".
    static let remoteCalls: Set<String> = [
        "AgoraShell.registerPush",
        "AgoraShell.unregisterPush",
        "AgoraShell.hasPushHandle",
        "PushNotifications.addListener",
        "PushNotifications.removeListener",
        "PushNotifications.removeAllListeners",
        "Device.getInfo",
        "Console.log"
    ]

    /// The only events an instance page may listen for, as "pluginId.eventName".
    static let remoteEvents: Set<String> = [
        "PushNotifications.pushNotificationActionPerformed"
    ]

    static func allowRemote(origin: String, pluginId: String, methodName: String, options: [String: Any]) -> Bool {
        guard !origin.isEmpty, !pluginId.contains("."), !methodName.contains("."),
              remoteCalls.contains("\(pluginId).\(methodName)") else { return false }
        if methodName == "addListener" {
            guard let eventName = options["eventName"] as? String else { return false }
            return remoteEvents.contains("\(pluginId).\(eventName)")
        }
        return true
    }
}

struct PushFailure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// The relay side of push registration (docs/planning/mobile-apps.md section 8). Mirrors PushRelay.java.
enum PushRelay {
    private static let handleCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

    /// 32 random bytes, base64url, no padding.
    static func isHandle(_ value: String?) -> Bool {
        guard let value = value, value.unicodeScalars.count == 43 else { return false }
        return value.unicodeScalars.allSatisfy { handleCharacters.contains($0) }
    }

    /// Whether to delete `previous` at the relay after registering returned `handle`: whenever
    /// they differ. With a new token the old handle points at a dead token; with the same token
    /// the relay no longer knew it, and a DELETE of an unknown handle is a harmless 204.
    static func replaces(previous: String?, handle: String) -> Bool {
        guard let previous = previous else { return false }
        return isHandle(previous) && previous != handle
    }

    /// unregisterPush only deletes the handle registered for the calling origin.
    static func mayUnregister(handle: String?, storedHandle: String?) -> Bool {
        guard let handle = handle else { return false }
        return isHandle(handle) && handle == storedHandle
    }

    /// Lower-case hex SHA-256, so the token itself is never stored by the shell.
    static func sha256(_ value: String) -> String {
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The handle from a /v1/register answer: a 201 with a well-formed new handle, or a 200
    /// handing back `previous` itself. Nil for anything else.
    static func handle(status: Int, data: Data, previous: String?) -> String? {
        guard status == 201 || status == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let handle = object["handle"] as? String, isHandle(handle) else { return nil }
        if status == 200 && handle != previous { return nil }
        return handle
    }

    /// One request to the relay. Blocking: call on AgoraShellPlugin's push queue only.
    static func send(relay: String, method: String, path: String, bearer: String?, body: [String: Any]?) -> (status: Int, data: Data)? {
        guard let url = URL(string: relay + path) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = method
        if let bearer = bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = DispatchSemaphore(value: 0)
        var result: (status: Int, data: Data)?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse { result = (http.statusCode, data ?? Data()) }
            done.signal()
        }.resume()
        done.wait()
        return result
    }
}

extension Notification.Name {
    static let agoraShowServerList = Notification.Name("AgoraShowServerList")
}

/// The shell's native plugin: navigation lock, launch state, saved-server refresh, and
/// push registration for instance pages. getLaunchState and serversChanged are for the
/// bundled picker (BridgePolicy refuses them to instance pages). The push methods are
/// called by the bridge filter with the origin WebKit reported for the calling page
/// (AgoraBridgeViewController.swift); the @objc versions refuse the picker.
@objc(AgoraShellPlugin)
public class AgoraShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgoraShellPlugin"
    public let jsName = "AgoraShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunchState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "serversChanged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregisterPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasPushHandle", returnType: CAPPluginReturnPromise)
    ]

    /// Set when the app was launched from the "Switch server" quick action.
    static var launchedForServerList = false

    /// Capacitor Preferences keeps its keys in UserDefaults under this prefix; the picker reads handles there.
    private static let preferencesPrefix = "CapacitorStorage."
    /// Native-only: SHA-256 of the device token each origin's handle was registered with. No page reads it.
    private static let tokenHashPrefix = "AgoraShell.pushTokenHash."
    private static let pageOnly = "Only a saved server's page can use this"

    private let lock = NSLock()
    private var autoOpenUsed = false
    private var saved: Set<String> = Origins.saved()
    /// Serialises relay registrations, so two calls for one origin never interleave.
    private let pushQueue = DispatchQueue(label: "com.caffeinatedsoftware.agora.push")
    /// Main thread only.
    private var tokenWaiters: [(Result<String, PushFailure>) -> Void] = []
    private var tokenTimeout: DispatchWorkItem?

    var savedOrigins: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return saved
    }

    lazy var relayOrigin: String? = Origins.httpsOrigin(getConfig().getString("relayUrl"))

    override public func load() {
        if AgoraShellPlugin.launchedForServerList { autoOpenUsed = true }
        NotificationCenter.default.addObserver(self, selector: #selector(showServerList), name: .agoraShowServerList, object: nil)
        // AppDelegate posts the APNs token here; the push plugin sees it too but has no page listeners for it.
        NotificationCenter.default.addObserver(self, selector: #selector(didRegisterForRemoteNotifications(_:)),
                                               name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didFailToRegisterForRemoteNotifications(_:)),
                                               name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
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

    // Reached only from the picker: instance pages' calls are run by the bridge filter.
    @objc func registerPush(_ call: CAPPluginCall) { call.reject(AgoraShellPlugin.pageOnly) }
    @objc func unregisterPush(_ call: CAPPluginCall) { call.reject(AgoraShellPlugin.pageOnly) }
    @objc func hasPushHandle(_ call: CAPPluginCall) { call.reject(AgoraShellPlugin.pageOnly) }

    @objc private func showServerList() {
        lock.lock(); autoOpenUsed = true; lock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let bridge = self?.bridge, let webView = bridge.webView else { return }
            webView.load(URLRequest(url: bridge.config.appStartServerURL))
        }
    }

    // MARK: Push registration for instance pages

    /// Run an AgoraShell push call for `origin`, the calling page's origin as WebKit reported it.
    /// `completion` gets the result data or an error message, on any thread.
    func runPageCall(methodName: String, origin: String, options: [String: Any],
                     completion: @escaping (Result<[String: Any], PushFailure>) -> Void) {
        switch methodName {
        case "registerPush":
            registerPush(origin: origin, completion: completion)
        case "unregisterPush":
            unregisterPush(origin: origin, handle: options["handle"] as? String, completion: completion)
        case "hasPushHandle":
            let handle = UserDefaults.standard.string(forKey: AgoraShellPlugin.handleKey(origin))
            completion(.success(["value": PushRelay.isHandle(handle)]))
        default:
            completion(.failure(PushFailure("Not available to this page")))
        }
    }

    private static func handleKey(_ origin: String) -> String {
        return preferencesPrefix + BridgePolicy.handleKeyPrefix + origin
    }

    private func registerPush(origin: String, completion: @escaping (Result<[String: Any], PushFailure>) -> Void) {
        guard let relay = relayOrigin else { return completion(.failure(PushFailure("relay_url_invalid"))) }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] settings in
            guard let self = self else { return }
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted {
                        self.registerWithToken(origin: origin, relay: relay, completion: completion)
                    } else {
                        completion(.success(["registered": false]))
                    }
                }
            case .denied:
                completion(.success(["registered": false]))
            default:
                self.registerWithToken(origin: origin, relay: relay, completion: completion)
            }
        }
    }

    private func registerWithToken(origin: String, relay: String, completion: @escaping (Result<[String: Any], PushFailure>) -> Void) {
        deviceToken { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let failure):
                completion(.failure(failure))
            case .success(let token):
                self.pushQueue.async {
                    completion(self.registerWithRelay(origin: origin, relay: relay, token: token))
                }
            }
        }
    }

    /// On pushQueue. Always asks the relay, naming the stored handle as `previous`: the relay hands
    /// it back while it still holds this token and origin, or issues a new one (pruned, lost, new token).
    private func registerWithRelay(origin: String, relay: String, token: String) -> Result<[String: Any], PushFailure> {
        let defaults = UserDefaults.standard
        let handleKey = AgoraShellPlugin.handleKey(origin)
        let hashKey = AgoraShellPlugin.tokenHashPrefix + origin
        let tokenHash = PushRelay.sha256(token)
        let stored = defaults.string(forKey: handleKey)
        let previous: String? = PushRelay.isHandle(stored) ? stored : nil
        var body: [String: Any] = ["platform": "ios", "token": token, "instance": origin]
        if let previous = previous { body["previous"] = previous }
        guard let response = PushRelay.send(relay: relay, method: "POST", path: "/v1/register", bearer: nil, body: body) else {
            return .failure(PushFailure("relay_register_failed: network"))
        }
        guard let handle = PushRelay.handle(status: response.status, data: response.data, previous: previous) else {
            return .failure(PushFailure("relay_register_failed: \(response.status)"))
        }
        defaults.set(handle, forKey: handleKey)
        defaults.set(tokenHash, forKey: hashKey)
        if let old = previous, PushRelay.replaces(previous: old, handle: handle) {
            // A new token (the old handle points at a dead token), or the relay no longer knew the
            // old handle (the DELETE is then a harmless 204). Best effort either way.
            _ = PushRelay.send(relay: relay, method: "DELETE", path: "/v1/handles", bearer: old, body: nil)
        }
        return .success(registration(relay: relay, handle: handle))
    }

    private func unregisterPush(origin: String, handle: String?, completion: @escaping (Result<[String: Any], PushFailure>) -> Void) {
        guard let handle = handle, PushRelay.isHandle(handle) else { return completion(.failure(PushFailure("handle_invalid"))) }
        guard let relay = relayOrigin else { return completion(.failure(PushFailure("relay_url_invalid"))) }
        pushQueue.async {
            let defaults = UserDefaults.standard
            let handleKey = AgoraShellPlugin.handleKey(origin)
            guard PushRelay.mayUnregister(handle: handle, storedHandle: defaults.string(forKey: handleKey)) else {
                return completion(.failure(PushFailure("handle_not_registered")))
            }
            guard let response = PushRelay.send(relay: relay, method: "DELETE", path: "/v1/handles", bearer: handle, body: nil) else {
                return completion(.failure(PushFailure("relay_unregister_failed: network")))
            }
            guard response.status == 204 || response.status == 401 else {
                return completion(.failure(PushFailure("relay_unregister_failed: \(response.status)")))
            }
            defaults.removeObject(forKey: handleKey)
            defaults.removeObject(forKey: AgoraShellPlugin.tokenHashPrefix + origin)
            // The device token itself stays registered: other saved servers may use it.
            completion(.success([:]))
        }
    }

    private func registration(relay: String, handle: String) -> [String: Any] {
        return ["registered": true, "relay": relay, "handle": handle, "platform": "ios"]
    }

    /// The APNs token, from AppDelegate's didRegisterForRemoteNotifications. Never handed to a page.
    private func deviceToken(_ completion: @escaping (Result<String, PushFailure>) -> Void) {
        DispatchQueue.main.async {
            self.tokenWaiters.append(completion)
            guard self.tokenWaiters.count == 1 else { return }
            let timeout = DispatchWorkItem { [weak self] in
                self?.finishTokenWait(.failure(PushFailure("push_token_timeout")))
            }
            self.tokenTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Main thread.
    private func finishTokenWait(_ result: Result<String, PushFailure>) {
        tokenTimeout?.cancel()
        tokenTimeout = nil
        let waiters = tokenWaiters
        tokenWaiters = []
        waiters.forEach { $0(result) }
    }

    @objc private func didRegisterForRemoteNotifications(_ notification: Notification) {
        var token: String?
        if let data = notification.object as? Data {
            token = data.map { String(format: "%02X", $0) }.joined()
        } else if let string = notification.object as? String {
            token = string
        }
        DispatchQueue.main.async {
            if let token = token, !token.isEmpty {
                self.finishTokenWait(.success(token))
            } else {
                self.finishTokenWait(.failure(PushFailure("push_token_empty")))
            }
        }
    }

    @objc private func didFailToRegisterForRemoteNotifications(_ notification: Notification) {
        let message = (notification.object as? Error)?.localizedDescription ?? "unknown"
        DispatchQueue.main.async {
            self.finishTokenWait(.failure(PushFailure("push_registration_failed: \(message)")))
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
