import Foundation

enum DatabaseEngine: String, CaseIterable, Identifiable {
    case postgreSQL = "PostgreSQL"
    case mySQL = "MySQL"
    case sqlServer = "SQL Server"

    var id: Self { self }

    var defaultPort: Int {
        switch self {
        case .postgreSQL:
            return 5432
        case .mySQL:
            return 3306
        case .sqlServer:
            return 1433
        }
    }

    var isImplemented: Bool {
        self == .postgreSQL
    }

    var plannedSupportMessage: String {
        switch self {
        case .postgreSQL:
            return "PostgreSQL is ready."
        case .mySQL:
            return "MySQL support is planned next through the same client layer."
        case .sqlServer:
            return "SQL Server support is planned after MySQL."
        }
    }
}

struct ConnectionProfile {
    let engine: DatabaseEngine
    let host: String
    let port: Int
    let database: String
    let username: String
    let password: String
}

struct ExplorerTable: Identifiable, Hashable {
    let schema: String
    let name: String
    let type: String

    var id: String {
        "\(schema).\(name)"
    }

    var qualifiedName: String {
        "\(schema.quotedIdentifier).\(name.quotedIdentifier)"
    }
}

struct ConnectionSummary {
    let title: String
    let detail: String
}

struct QueryResult {
    let columns: [String]
    let rows: [[String]]
    let executionTime: TimeInterval
    let statusText: String
}

extension String {
    var quotedIdentifier: String {
        let escaped = replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}
