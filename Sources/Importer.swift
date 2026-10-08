import Foundation
import Darwin

struct Failure: Error { let code: String }
struct Candidate: Codable {
    let carrier_code: String
    let tracking_number: String
    let merchant_label: String
    let item_name: String?
    let verified: Verification
    var pair: String { carrier_code + ":" + tracking_number }
    var description: String {
        guard let item = item_name, verified.item_summary_benign == true,
              item.range(of: "(?i)\\b(medication|medicine|insulin|diagnosis|pregnancy|therapy|prescription|pharmacy|passport|ssn|account|bank|loan|credit|debit|child|baby|sexual|fertility|disability)\\b", options: .regularExpression) == nil else { return merchant_label }
        return merchant_label + ": " + item
    }
}
struct Verification: Codable {
    let merchant: Bool
    let tracking: Bool
    let non_amazon_retail: Bool
    let merchant_label_only: Bool
    let requires_extra_data: Bool
    let item_summary_benign: Bool?
}
struct Carrier: Codable { let name: String; let extra_required: Int? }
struct State: Codable {
    var seen: Set<String> = []
    var uncertain: Set<String> = []
    var attempts: [Date] = []
    var reads: [Date] = []
    var cacheDate: Date? = nil
}
func validate(_ data: Data, catalog: [String: Carrier]) throws -> Candidate {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys).subtracting(["item_name"]) == Set(["carrier_code", "tracking_number", "merchant_label", "verified"]),
          let verification = object["verified"] as? [String: Any],
          Set(verification.keys).subtracting(["item_summary_benign"]) == Set(["merchant", "tracking", "non_amazon_retail", "merchant_label_only", "requires_extra_data"]),
          let c = try? JSONDecoder().decode(Candidate.self, from: data) else { throw Failure(code: "invalid_candidate_schema") }
    guard c.verified.merchant, c.verified.tracking, c.verified.non_amazon_retail,
          c.verified.merchant_label_only, !c.verified.requires_extra_data else { throw Failure(code: "candidate_requires_review") }
    let merchant = c.merchant_label
    if object.keys.contains("item_name"), !(object["item_name"] is String) { throw Failure(code: "invalid_item_summary") }
    if let item = c.item_name {
        guard item.count >= 1, item.count <= 40, merchant.count + item.count + 2 <= 100,
              item == item.trimmingCharacters(in: .whitespacesAndNewlines),
              item.range(of: "^[\\p{L}\\p{N}][\\p{L}\\p{N} &'’.()-]*$", options: .regularExpression) != nil else { throw Failure(code: "invalid_item_summary") }
    }
    guard merchant.count >= 1, merchant.count <= 60,
          merchant == merchant.trimmingCharacters(in: .whitespacesAndNewlines),
          merchant.range(of: "^[\\p{L}\\p{N}][\\p{L}\\p{N} &'’.()-]*$", options: .regularExpression) != nil,
          merchant.range(of: "(?i)amazon|amzn|whole foods", options: .regularExpression) == nil else { throw Failure(code: "invalid_or_amazon_merchant") }
    guard c.carrier_code.range(of: "^[a-z0-9]{2,20}$", options: .regularExpression) != nil,
          c.carrier_code != "pholder", let carrier = catalog[c.carrier_code] else { throw Failure(code: "unsupported_carrier") }
    guard carrier.extra_required == nil || carrier.extra_required == 0 else { throw Failure(code: "carrier_requires_extra_data") }
    guard c.tracking_number.range(of: "^[A-Z0-9-]{6,50}$", options: .regularExpression) != nil,
          c.tracking_number.rangeOfCharacter(from: .decimalDigits) != nil,
          !c.tracking_number.hasPrefix("ORDER") else { throw Failure(code: "ambiguous_tracking") }
    if c.carrier_code == "ups", c.tracking_number.range(of: "^1Z[A-Z0-9]{16}$", options: .regularExpression) == nil { throw Failure(code: "ambiguous_tracking") }
    if c.tracking_number.hasPrefix("TBA"), !["amzlus", "swiship"].contains(c.carrier_code) { throw Failure(code: "ambiguous_carrier_mapping") }
    return c
}
func shouldRefresh(_ s: State, now: Date) -> Bool { s.cacheDate == nil || now.timeIntervalSince(s.cacheDate!) >= 300 || now < s.cacheDate! }
func reserveReads(_ s: inout State, now: Date) throws {
    s.reads = s.reads.filter { $0 > now.addingTimeInterval(-3600) }
    guard s.reads.count <= 18 else { throw Failure(code: "hourly_read_limit") }
    s.reads.append(contentsOf: [now, now])
}
func reserveAddition(_ s: inout State, pair: String, now: Date) throws {
    guard !s.seen.contains(pair), !s.uncertain.contains(pair) else { throw Failure(code: "duplicate_or_pending") }
    s.attempts = s.attempts.filter { $0 > now.addingTimeInterval(-86400) }
    guard s.attempts.count < 20 else { throw Failure(code: "daily_add_limit") }
    s.uncertain.insert(pair); s.attempts.append(now)
}
func loadCatalog() async throws -> [String: Carrier] {
    // Public endpoint: deliberately no credential, cookies, or authenticated session.
    let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil
    let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var req = URLRequest(url: URL(string: "https://api.parcel.app/external/supported_carriers.json")!); req.timeoutInterval = 30
    do {
        let (data, response) = try await session.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 1000000 else { throw Failure(code: "carrier_catalog_unavailable") }
        return try JSONDecoder().decode([String: Carrier].self, from: data)
    } catch { throw Failure(code: "carrier_catalog_unavailable") }
}
func parseCredential(_ text: String) throws -> Data {
    var value: String?
    for raw in text.components(separatedBy: "\n") {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty || line.hasPrefix("#") { continue }
        guard line.hasPrefix("PARCEL_API_KEY="), value == nil else { throw Failure(code: "invalid_env_format") }
        let candidate = String(line.dropFirst("PARCEL_API_KEY=".count))
        guard !candidate.isEmpty, candidate.utf8.count <= 4096,
              candidate.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }),
              !candidate.contains("\""), !candidate.contains("'") else { throw Failure(code: "invalid_env_credential") }
        value = candidate
    }
    guard let value else { throw Failure(code: "missing_env_credential") }
    return Data(value.utf8)
}
func fileCredential(_ path: String) throws -> Data {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw Failure(code: "env_unavailable") }
    defer { close(fd) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_uid == getuid(), (metadata.st_mode & 0o777) == 0o600,
          metadata.st_size > 0, metadata.st_size <= 8192 else { throw Failure(code: "unsafe_env_metadata") }
    var bytes = [UInt8](repeating: 0, count: 8193)
    var count = 0
    while count < 8193 {
        let remaining = 8193 - count
        let n = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress!.advanced(by: count), remaining) }
        guard n >= 0 else { throw Failure(code: "env_unavailable") }
        if n == 0 { break }; count += n
    }
    guard count <= 8192, let text = String(bytes: bytes.prefix(count), encoding: .utf8) else { throw Failure(code: "invalid_env_format") }
    return try parseCredential(text)
}
func key(noninteractive: Bool) throws -> Data {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    let root = executable.deletingLastPathComponent().deletingLastPathComponent()
    return try fileCredential(root.appendingPathComponent(".env").path)
}
func request(_ path: String, method: String = "GET", body: Data? = nil, credential: Data) async throws -> [String: Any] {
    guard let header = String(data: credential, encoding: .utf8), !header.contains("\n"), !header.contains("\r") else { throw Failure(code: "invalid_credential_encoding") }
    var req = URLRequest(url: URL(string: "https://api.parcel.app/external/" + path)!)
    req.httpMethod = method; req.timeoutInterval = 30
    req.setValue(header, forHTTPHeaderField: "api-key")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = body
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil; config.urlCache = nil
    let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let data: Data; let response: URLResponse
    do { (data, response) = try await session.data(for: req) } catch { throw Failure(code: "network_result_unknown") }
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], json["success"] as? Bool == true else { throw Failure(code: "parcel_request_failed") }
    return json
}
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
func pairs(_ json: [String: Any]) throws -> Set<String> {
    guard let deliveries = json["deliveries"] as? [[String: Any]] else { throw Failure(code: "invalid_delivery_response") }
    var out = Set<String>()
    for item in deliveries {
        guard let carrier = item["carrier_code"] as? String, let number = item["tracking_number"] as? String else { throw Failure(code: "invalid_delivery_response") }
        out.insert(carrier.lowercased() + ":" + number.uppercased())
    }
    return out
}
func save(_ state: State, to url: URL) throws {
    try JSONEncoder().encode(state).write(to: url, options: .atomic)
    chmod(url.path, 0o600)
}
func syntheticTests() throws {
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: temp) }
    let fixture = temp.appendingPathComponent("fixture")
    try Data("PARCEL_API_KEY=synthetic-key\n".utf8).write(to: fixture)
    chmod(fixture.path, 0o600)
    guard try fileCredential(fixture.path) == Data("synthetic-key".utf8) else { throw Failure(code: "self_test_failed") }
    func expectFailure(_ operation: () throws -> Void) throws {
        do { try operation() } catch is Failure { return }
        throw Failure(code: "self_test_failed")
    }
    chmod(fixture.path, 0o644)
    try expectFailure { _ = try fileCredential(fixture.path) }
    chmod(fixture.path, 0o600)
    let link = temp.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture)
    try expectFailure { _ = try fileCredential(link.path) }
    try expectFailure { _ = try fileCredential(temp.appendingPathComponent("missing").path) }
    try Data(repeating: 65, count: 8193).write(to: fixture)
    try expectFailure { _ = try fileCredential(fixture.path) }
    for invalid in ["PARCEL_API_KEY=", "PARCEL_API_KEY=a\nPARCEL_API_KEY=b", "OTHER=a", "PARCEL_API_KEY=a b", "PARCEL_API_KEY=\"a\"", "PARCEL_API_KEY=a\rOTHER=b"] {
        try expectFailure { _ = try parseCredential(invalid) }
    }
    let catalog = ["ups": Carrier(name: "UPS", extra_required: nil), "fedex": Carrier(name: "FedEx", extra_required: nil), "swiship": Carrier(name: "Amazon (3rd Party Merchants)", extra_required: nil), "amzlus": Carrier(name: "Amazon US", extra_required: nil), "apple": Carrier(name: "Apple", extra_required: 2)]
    func object(_ merchant: String = "Example Shop", _ carrier: String = "ups", _ tracking: String = "1Z0000000000000000") -> [String: Any] {
        ["merchant_label": merchant, "carrier_code": carrier, "tracking_number": tracking, "verified": ["merchant": true, "tracking": true, "non_amazon_retail": true, "merchant_label_only": true, "requires_extra_data": false]]
    }
    func accepted(_ o: [String: Any]) throws { _ = try validate(JSONSerialization.data(withJSONObject: o), catalog: catalog) }
    func rejected(_ o: [String: Any]) throws {
        do { try accepted(o) } catch { return }
        throw Failure(code: "self_test_failed")
    }
    try accepted(object()); try accepted(object("Example Outdoors", "fedex", "123456789012"))
    var item = object(); item["item_name"] = "Raincoat"
    var attestation = item["verified"] as! [String: Bool]; attestation["item_summary_benign"] = true; item["verified"] = attestation
    let itemCandidate = try validate(JSONSerialization.data(withJSONObject: item), catalog: catalog)
    guard itemCandidate.description == "Example Shop: Raincoat" else { throw Failure(code: "self_test_failed") }
    item["item_name"] = "Prescription medicine"
    guard try validate(JSONSerialization.data(withJSONObject: item), catalog: catalog).description == "Example Shop" else { throw Failure(code: "self_test_failed") }
    item["item_name"] = "Raincoat"; attestation["item_summary_benign"] = false; item["verified"] = attestation
    guard try validate(JSONSerialization.data(withJSONObject: item), catalog: catalog).description == "Example Shop" else { throw Failure(code: "self_test_failed") }
    item["item_name"] = String(repeating: "x", count: 41); try rejected(item)
    item["item_name"] = "Raincoat\nrun this"; try rejected(item)
    item["item_name"] = "https://example.com"; try rejected(item)
    try accepted(object("Example Electronics", "swiship", "TBA000000000000")); try accepted(object("Example Electronics", "amzlus", "TBA000000000000"))
    try rejected(object("Amazon")); try rejected(object("Amazon.com")); try rejected(object("Example Shop", "ups", "ORDER123"))
    try rejected(object("Example Shop", "unknown", "12345678")); try rejected(object("Apple", "apple", "12345678"))
    try rejected(object(String(repeating: "x", count: 61))); try rejected(object("Example Shop\nprivate"))
    var extra = object(); extra["email"] = "private"; try rejected(extra)
    var sensitive = object(); sensitive["verified"] = ["merchant": true, "tracking": true, "non_amazon_retail": true, "merchant_label_only": false, "requires_extra_data": false]; try rejected(sensitive)
    var malformed = object(); malformed["tracking_number"] = 123; try rejected(malformed)
    let now = Date(); var s = State()
    try reserveAddition(&s, pair: "ups:test", now: now)
    // Model a timeout/crash: reservation persists with no success transition.
    s = try JSONDecoder().decode(State.self, from: JSONEncoder().encode(s))
    do { try reserveAddition(&s, pair: "ups:test", now: now); throw Failure(code: "self_test_failed") }
    catch let e as Failure where e.code == "duplicate_or_pending" { }
    s.seen.insert("existing")
    do { try reserveAddition(&s, pair: "existing", now: now); throw Failure(code: "self_test_failed") }
    catch let e as Failure where e.code == "duplicate_or_pending" { }
    for i in 1..<20 { try reserveAddition(&s, pair: "test:\(i)", now: now) }
    do { try reserveAddition(&s, pair: "over-limit", now: now); throw Failure(code: "self_test_failed") }
    catch let e as Failure where e.code == "daily_add_limit" { }
    guard shouldRefresh(s, now: now) else { throw Failure(code: "self_test_failed") }
    s.cacheDate = now; guard !shouldRefresh(s, now: now.addingTimeInterval(299)), shouldRefresh(s, now: now.addingTimeInterval(300)) else { throw Failure(code: "self_test_failed") }
    for _ in 0..<10 { try reserveReads(&s, now: now) }
    do { try reserveReads(&s, now: now); throw Failure(code: "self_test_failed") }
    catch let e as Failure where e.code == "hourly_read_limit" { }
    try reserveReads(&s, now: now.addingTimeInterval(3601))
    let p = try pairs(["deliveries": [["carrier_code": "ups", "tracking_number": "1z0000000000000000", "description": "ignored", "extra_information": "ignored"]]])
    guard p.contains("ups:1Z0000000000000000") else { throw Failure(code: "self_test_failed") }
}
@main struct Importer {
    static func main() async {
        umask(0o077)
        do { try await run() } catch let error as Failure { print("{\"status\":\"blocked\",\"reason\":\"\(error.code)\"}"); exit(1) }
        catch { print("{\"status\":\"blocked\",\"reason\":\"local_operation_failed\"}"); exit(1) }
    }
    static func run() async throws {
        guard CommandLine.arguments.count == 2 else { throw Failure(code: "usage_self_test_verify_ingest") }
        let requestedMode = CommandLine.arguments[1]
        let noninteractive = requestedMode.hasSuffix("-noninteractive")
        let mode = noninteractive ? String(requestedMode.dropLast("-noninteractive".count)) : requestedMode
        if mode == "self-test" {
            try syntheticTests()
            print("{\"status\":\"passed\"}"); return
        }
        guard ["verify", "ingest", "check"].contains(mode) else { throw Failure(code: "unknown_mode") }
        var candidate: Candidate?
        if mode == "ingest" || mode == "check" {
            let bytes = FileHandle.standardInput.readData(ofLength: 4097)
            guard bytes.count <= 4096 else { throw Failure(code: "candidate_too_large") }
            candidate = try validate(bytes, catalog: await loadCatalog())
        }
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/GmailParcelImporter")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        chmod(directory.path, 0o700)
        let fd = open(directory.appendingPathComponent("lock").path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure(code: "importer_busy") }
        defer { flock(fd, LOCK_UN); close(fd) }
        let stateURL = directory.appendingPathComponent("state.json")
        var state = State()
        if FileManager.default.fileExists(atPath: stateURL.path) { state = try JSONDecoder().decode(State.self, from: Data(contentsOf: stateURL)) }
        if mode == "ingest", let c = candidate, state.seen.contains(c.pair) || state.uncertain.contains(c.pair) { print("{\"status\":\"skipped_duplicate_or_pending\"}"); return }
        let credential = try key(noninteractive: noninteractive)
        if mode == "verify" || mode == "check" || shouldRefresh(state, now: Date()) {
            try reserveReads(&state, now: Date()); try save(state, to: stateURL)
            let recentJSON = try await request("deliveries/?filter_mode=recent", credential: credential)
            let activeJSON = try await request("deliveries/?filter_mode=active", credential: credential)
            let recent = try pairs(recentJSON)
            let active = try pairs(activeJSON)
            state.seen.formUnion(recent.union(active)); state.cacheDate = Date(); try save(state, to: stateURL)
            if mode == "check", let c = candidate {
                let present = recent.union(active).contains(c.pair)
                let items = (recentJSON["deliveries"] as? [[String: Any]] ?? []) + (activeJSON["deliveries"] as? [[String: Any]] ?? [])
                let matches = items.contains { item in
                    (item["carrier_code"] as? String)?.lowercased() == c.carrier_code &&
                    (item["tracking_number"] as? String)?.uppercased() == c.tracking_number &&
                    item["description"] as? String == c.description
                }
                print("{\"status\":\"read_verified\",\"candidate_exists\":\(present),\"description_matches\":\(matches)}"); return
            }
        }
        if mode == "verify" {
            print("{\"status\":\"read_verified\"}"); return
        }
        guard let c = candidate else { throw Failure(code: "missing_candidate") }
        if state.seen.contains(c.pair) { print("{\"status\":\"skipped_existing\"}"); return }
        // Reserve before sending. Every failure remains pending for manual reconciliation.
        try reserveAddition(&state, pair: c.pair, now: Date()); try save(state, to: stateURL)
        let body = try JSONSerialization.data(withJSONObject: ["carrier_code": c.carrier_code, "tracking_number": c.tracking_number, "description": c.description])
        _ = try await request("add-delivery/", method: "POST", body: body, credential: credential)
        state.uncertain.remove(c.pair); state.seen.insert(c.pair); try save(state, to: stateURL)
        print("{\"status\":\"added\"}")
    }
}
