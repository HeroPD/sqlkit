import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = ExplorerViewModel()

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .navigationTitle("SqlKit")
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connection")
                .font(.headline)

            Picker("Database", selection: $viewModel.engine) {
                ForEach(DatabaseEngine.allCases) { engine in
                    Text(engine.rawValue).tag(engine)
                }
            }
            .pickerStyle(.segmented)

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Host")
                        .foregroundStyle(.secondary)
                    TextField("localhost", text: $viewModel.host)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("Port")
                        .foregroundStyle(.secondary)
                    TextField("5432", text: $viewModel.portText)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("Database")
                        .foregroundStyle(.secondary)
                    TextField("postgres", text: $viewModel.database)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("User")
                        .foregroundStyle(.secondary)
                    TextField("postgres", text: $viewModel.username)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("Password")
                        .foregroundStyle(.secondary)
                    SecureField("Optional", text: $viewModel.password)
                        .textFieldStyle(.roundedBorder)
                }
            }

            HStack {
                Button(viewModel.isConnecting ? "Connecting..." : "Connect") {
                    viewModel.connect()
                }
                .disabled(viewModel.isConnecting || !viewModel.engine.isImplemented)

                Button("Refresh Tables") {
                    viewModel.refreshTables()
                }
                .disabled(viewModel.isConnecting || !viewModel.engine.isImplemented)
            }

            Text(viewModel.connectionStatus)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            } else {
                Text(viewModel.infoMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            HStack {
                Text("Explorer")
                    .font(.headline)
                Spacer()
                Button("Browse") {
                    viewModel.browseSelectedTable()
                }
                .disabled(viewModel.selectedTable == nil)
            }

            if viewModel.tables.isEmpty {
                ContentUnavailableView(
                    "No Tables Loaded",
                    systemImage: "square.stack.3d.up.slash",
                    description: Text("Connect to PostgreSQL to inspect schemas and tables.")
                )
            } else {
                List(viewModel.tables, selection: $viewModel.selectedTable) { table in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(table.name)
                        Text(table.schema)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(table)
                }
                .listStyle(.sidebar)
            }
        }
        .padding(16)
        .navigationSplitViewColumnWidth(min: 280, ideal: 320)
    }

    private var detail: some View {
        VSplitView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Query")
                        .font(.headline)
                    Spacer()
                    if let selectedTable = viewModel.selectedTable {
                        Button("Use Selected Table") {
                            viewModel.prepareQuery(for: selectedTable)
                        }
                    }
                    Button(viewModel.isRunningQuery ? "Running..." : "Run") {
                        viewModel.runQuery()
                    }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(viewModel.isRunningQuery || !viewModel.engine.isImplemented)
                }

                TextEditor(text: $viewModel.queryText)
                    .font(.system(.body, design: .monospaced))
                    .padding(10)
                    .background(Color(nsColor: .textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .padding(16)
            .frame(minHeight: 220)

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Results")
                        .font(.headline)
                    Spacer()
                    if let summary = viewModel.resultSummary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                QueryResultGrid(result: viewModel.queryResult)
            }
            .padding(16)
        }
    }
}

private struct QueryResultGrid: View {
    let result: QueryResult?

    private let rowNumberWidth: CGFloat = 56
    private let columnWidth: CGFloat = 180

    var body: some View {
        if let result {
            if result.columns.isEmpty {
                ContentUnavailableView(
                    "No Result Set",
                    systemImage: "tablecells",
                    description: Text(result.statusText)
                )
            } else {
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Section {
                            ForEach(Array(result.rows.enumerated()), id: \.offset) { index, row in
                                HStack(spacing: 0) {
                                    cell("\(index + 1)", width: rowNumberWidth, isHeader: false)
                                        .foregroundStyle(.secondary)

                                    ForEach(Array(result.columns.enumerated()), id: \.offset) { columnIndex, _ in
                                        cell(row[safe: columnIndex] ?? "", width: columnWidth, isHeader: false)
                                    }
                                }
                                .background(index.isMultiple(of: 2) ? Color.clear : Color(nsColor: .controlBackgroundColor))
                            }
                        } header: {
                            HStack(spacing: 0) {
                                cell("#", width: rowNumberWidth, isHeader: true)
                                ForEach(result.columns, id: \.self) { column in
                                    cell(column, width: columnWidth, isHeader: true)
                                }
                            }
                            .background(Color(nsColor: .windowBackgroundColor))
                        }
                    }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                }
            }
        } else {
            ContentUnavailableView(
                "Run a Query",
                systemImage: "play.circle",
                description: Text("Execute a statement to inspect rows or status output.")
            )
        }
    }

    private func cell(_ value: String, width: CGFloat, isHeader: Bool) -> some View {
        Text(value.isEmpty ? " " : value)
            .font(.system(size: 12, weight: isHeader ? .semibold : .regular, design: .monospaced))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(width: width, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(width: 1)
            }
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(height: 1)
            }
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

#Preview {
    ContentView()
}
