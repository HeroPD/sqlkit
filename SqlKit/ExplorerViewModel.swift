import Foundation
import Combine

@MainActor
final class ExplorerViewModel: ObservableObject {
    @Published var engine: DatabaseEngine = .postgreSQL {
        didSet {
            if portText == String(oldValue.defaultPort) || portText.isEmpty {
                portText = String(engine.defaultPort)
            }

            if engine != .postgreSQL {
                tables = []
                selectedTable = nil
                connectionStatus = engine.plannedSupportMessage
                infoMessage = "PostgreSQL is the first supported backend."
            } else if oldValue != engine {
                connectionStatus = "Ready to connect to PostgreSQL"
                infoMessage = engine.plannedSupportMessage
            }
        }
    }

    @Published var host = "localhost"
    @Published var portText = "5432"
    @Published var database = "postgres"
    @Published var username = "postgres"
    @Published var password = ""
    @Published var queryText = """
    select table_schema, table_name, table_type
    from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema')
    order by table_schema, table_name
    limit 200;
    """
    @Published private(set) var tables: [ExplorerTable] = []
    @Published var selectedTable: ExplorerTable?
    @Published private(set) var queryResult: QueryResult?
    @Published private(set) var isConnecting = false
    @Published private(set) var isRunningQuery = false
    @Published private(set) var connectionStatus = "Ready to connect to PostgreSQL"
    @Published private(set) var infoMessage = "PostgreSQL is ready."
    @Published private(set) var errorMessage: String?

    var resultSummary: String? {
        guard let queryResult else {
            return nil
        }

        let duration = String(format: "%.2fs", queryResult.executionTime)

        if queryResult.columns == ["status"] {
            return duration
        }

        return "\(queryResult.rows.count) row\(queryResult.rows.count == 1 ? "" : "s") • \(duration)"
    }

    func connect() {
        Task {
            await connectImpl()
        }
    }

    func refreshTables() {
        Task {
            await refreshTablesImpl()
        }
    }

    func runQuery() {
        Task {
            await runQueryImpl()
        }
    }

    func prepareQuery(for table: ExplorerTable) {
        queryText = "select * from \(table.qualifiedName) limit 200;"
    }

    func browseSelectedTable() {
        guard let selectedTable else {
            return
        }

        prepareQuery(for: selectedTable)
        runQuery()
    }

    private func connectImpl() async {
        guard engine.isImplemented else {
            errorMessage = nil
            connectionStatus = engine.plannedSupportMessage
            infoMessage = "PostgreSQL is the first supported backend."
            return
        }

        isConnecting = true
        errorMessage = nil
        connectionStatus = "Connecting..."

        let profile = currentProfile
        let client = DatabaseClientFactory.makeClient(for: profile.engine)

        defer {
            isConnecting = false
        }

        do {
            let summary = try await client.connectSummary(using: profile)
            let fetchedTables = try await client.fetchTables(using: profile)
            tables = fetchedTables
            selectedTable = fetchedTables.first
            connectionStatus = summary.title
            infoMessage = summary.detail
        } catch {
            tables = []
            selectedTable = nil
            connectionStatus = "Connection failed"
            errorMessage = error.localizedDescription
        }
    }

    private func refreshTablesImpl() async {
        guard engine.isImplemented else {
            return
        }

        isConnecting = true
        errorMessage = nil

        let profile = currentProfile
        let client = DatabaseClientFactory.makeClient(for: profile.engine)

        defer {
            isConnecting = false
        }

        do {
            let fetchedTables = try await client.fetchTables(using: profile)
            tables = fetchedTables
            if !fetchedTables.contains(selectedTable ?? ExplorerTable(schema: "", name: "", type: "")) {
                selectedTable = fetchedTables.first
            }
            connectionStatus = "Loaded \(fetchedTables.count) table\(fetchedTables.count == 1 ? "" : "s")"
            infoMessage = engine.plannedSupportMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runQueryImpl() async {
        guard engine.isImplemented else {
            errorMessage = engine.plannedSupportMessage
            return
        }

        isRunningQuery = true
        errorMessage = nil

        let profile = currentProfile
        let client = DatabaseClientFactory.makeClient(for: profile.engine)

        defer {
            isRunningQuery = false
        }

        do {
            queryResult = try await client.execute(query: queryText, using: profile)
            connectionStatus = "Query finished"
            infoMessage = queryResult?.statusText ?? engine.plannedSupportMessage
        } catch {
            queryResult = nil
            errorMessage = error.localizedDescription
            connectionStatus = "Query failed"
        }
    }

    private var currentProfile: ConnectionProfile {
        ConnectionProfile(
            engine: engine,
            host: host.trimmingCharacters(in: .whitespacesAndNewlines),
            port: Int(portText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? engine.defaultPort,
            database: database.trimmingCharacters(in: .whitespacesAndNewlines),
            username: username.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password
        )
    }
}
