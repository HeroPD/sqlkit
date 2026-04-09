import Foundation

protocol DatabaseClient {
    func connectSummary(using profile: ConnectionProfile) async throws -> ConnectionSummary
    func fetchTables(using profile: ConnectionProfile) async throws -> [ExplorerTable]
    func execute(query: String, using profile: ConnectionProfile) async throws -> QueryResult
}

enum DatabaseClientFactory {
    static func makeClient(for engine: DatabaseEngine) -> any DatabaseClient {
        switch engine {
        case .postgreSQL:
            return PostgresCommandLineClient()
        case .mySQL, .sqlServer:
            return UnsupportedDatabaseClient(engine: engine)
        }
    }
}

enum DatabaseClientError: LocalizedError {
    case invalidConfiguration(String)
    case unsupportedEngine(String)
    case missingCommandLineTool(String)
    case commandFailed(String)
    case invalidCSVOutput
    case emptyQuery

    var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message):
            return message
        case let .unsupportedEngine(message):
            return message
        case let .missingCommandLineTool(message):
            return message
        case let .commandFailed(message):
            return message
        case .invalidCSVOutput:
            return "The query returned data in an unexpected format."
        case .emptyQuery:
            return "Enter a SQL statement before running the query."
        }
    }
}

private struct UnsupportedDatabaseClient: DatabaseClient {
    let engine: DatabaseEngine

    func connectSummary(using profile: ConnectionProfile) async throws -> ConnectionSummary {
        throw DatabaseClientError.unsupportedEngine(engine.plannedSupportMessage)
    }

    func fetchTables(using profile: ConnectionProfile) async throws -> [ExplorerTable] {
        throw DatabaseClientError.unsupportedEngine(engine.plannedSupportMessage)
    }

    func execute(query: String, using profile: ConnectionProfile) async throws -> QueryResult {
        throw DatabaseClientError.unsupportedEngine(engine.plannedSupportMessage)
    }
}

private struct PostgresCommandLineClient: DatabaseClient {
    func connectSummary(using profile: ConnectionProfile) async throws -> ConnectionSummary {
        let query = """
        select current_database() as database, current_user as user_name, version() as version;
        """

        let result = try await execute(query: query, using: profile)
        guard let row = result.rows.first else {
            throw DatabaseClientError.commandFailed("Connected, but PostgreSQL did not return server metadata.")
        }

        let database = row[safe: 0] ?? profile.database
        let user = row[safe: 1] ?? profile.username
        let version = row[safe: 2] ?? "PostgreSQL"

        return ConnectionSummary(
            title: "Connected to \(database) on \(profile.host):\(profile.port)",
            detail: "\(user) • \(version)"
        )
    }

    func fetchTables(using profile: ConnectionProfile) async throws -> [ExplorerTable] {
        let query = """
        select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name;
        """

        let result = try await execute(query: query, using: profile)
        return result.rows.map { row in
            ExplorerTable(
                schema: row[safe: 0] ?? "public",
                name: row[safe: 1] ?? "unknown",
                type: row[safe: 2] ?? "TABLE"
            )
        }
    }

    func execute(query: String, using profile: ConnectionProfile) async throws -> QueryResult {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            throw DatabaseClientError.emptyQuery
        }

        try validate(profile)

        let response = try await runPSQL(query: trimmedQuery, using: profile)
        let trimmedOutput = response.stdout.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedOutput.isEmpty {
            let status = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return QueryResult(
                columns: ["status"],
                rows: [[status.isEmpty ? "Query completed successfully." : status]],
                executionTime: response.duration,
                statusText: status.isEmpty ? "Query completed successfully." : status
            )
        }

        let records = try CSVParser.parse(trimmedOutput)
        guard let header = records.first else {
            throw DatabaseClientError.invalidCSVOutput
        }

        if shouldTreatAsTable(query: trimmedQuery, records: records) {
            let rows = Array(records.dropFirst())
            return QueryResult(
                columns: header,
                rows: rows,
                executionTime: response.duration,
                statusText: "Returned \(rows.count) row\(rows.count == 1 ? "" : "s")"
            )
        }

        let status = header.first ?? trimmedOutput
        return QueryResult(
            columns: ["status"],
            rows: [[status]],
            executionTime: response.duration,
            statusText: status
        )
    }

    private func validate(_ profile: ConnectionProfile) throws {
        guard !profile.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DatabaseClientError.invalidConfiguration("Host is required.")
        }

        guard !profile.database.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DatabaseClientError.invalidConfiguration("Database name is required.")
        }

        guard !profile.username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DatabaseClientError.invalidConfiguration("User name is required.")
        }
    }

    private func shouldTreatAsTable(query: String, records: [[String]]) -> Bool {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let rowProducingPrefixes = ["select", "with", "show", "values", "explain"]

        if rowProducingPrefixes.contains(where: { normalized.hasPrefix($0) }) {
            return true
        }

        return records.count > 1
    }

    private func runPSQL(query: String, using profile: ConnectionProfile) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            let startedAt = Date()

            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [
                "psql",
                "--no-psqlrc",
                "--no-password",
                "--csv",
                "--set", "ON_ERROR_STOP=1",
                "--pset", "footer=off",
                "--pset", "null=(null)",
                "--host", profile.host,
                "--port", String(profile.port),
                "--username", profile.username,
                "--dbname", profile.database,
                "--command", query
            ]
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            var environment = ProcessInfo.processInfo.environment
            if !profile.password.isEmpty {
                environment["PGPASSWORD"] = profile.password
            }
            process.environment = environment

            process.terminationHandler = { process in
                let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stdout = String(decoding: stdoutData, as: UTF8.self)
                let stderr = String(decoding: stderrData, as: UTF8.self)
                let duration = Date().timeIntervalSince(startedAt)

                if process.terminationStatus == 0 {
                    continuation.resume(returning: ProcessResult(stdout: stdout, stderr: stderr, duration: duration))
                    return
                }

                let combinedMessage = [stderr, stdout]
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .first { !$0.isEmpty } ?? "psql exited with status \(process.terminationStatus)."

                if combinedMessage.contains("psql") && combinedMessage.contains("No such file") {
                    continuation.resume(throwing: DatabaseClientError.missingCommandLineTool("Install PostgreSQL command line tools so SqlKit can use `psql` for now."))
                } else {
                    continuation.resume(throwing: DatabaseClientError.commandFailed(combinedMessage))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: DatabaseClientError.missingCommandLineTool("SqlKit could not launch `psql`. Install PostgreSQL command line tools and try again."))
            }
        }
    }
}

private struct ProcessResult {
    let stdout: String
    let stderr: String
    let duration: TimeInterval
}

private enum CSVParser {
    static func parse(_ text: String) throws -> [[String]] {
        var rows: [[String]] = []
        var currentRow: [String] = []
        var currentField = ""
        var isInsideQuotes = false
        let characters = Array(text)
        var index = 0

        while index < characters.count {
            let character = characters[index]

            if isInsideQuotes {
                if character == "\"" {
                    if index + 1 < characters.count, characters[index + 1] == "\"" {
                        currentField.append("\"")
                        index += 1
                    } else {
                        isInsideQuotes = false
                    }
                } else {
                    currentField.append(character)
                }
            } else {
                switch character {
                case "\"":
                    isInsideQuotes = true
                case ",":
                    currentRow.append(currentField)
                    currentField = ""
                case "\n":
                    currentRow.append(currentField)
                    rows.append(currentRow)
                    currentRow = []
                    currentField = ""
                case "\r":
                    break
                default:
                    currentField.append(character)
                }
            }

            index += 1
        }

        if isInsideQuotes {
            throw DatabaseClientError.invalidCSVOutput
        }

        if !currentField.isEmpty || !currentRow.isEmpty {
            currentRow.append(currentField)
            rows.append(currentRow)
        }

        return rows
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        guard indices.contains(index) else {
            return nil
        }

        return self[index]
    }
}
