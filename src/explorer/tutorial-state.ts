/**
 * Tutorial state machine for the Graph Explorer.
 *
 * This module extracts the core tutorial logic (chapter definitions, navigation,
 * serialization, validation, cleanup) so it can be tested independently of the
 * browser DOM.
 *
 * The HTML SPA mirrors these definitions — keep them in sync.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TutorialChapter {
  id: string;
  title: string;
  /** Static instruction string, or a function that returns one (for dynamic RIDs). */
  instruction: string | (() => string);
  task: string;
  highlight: string;
  /** Card placement hint: 'left' | 'right' (default). */
  cardPosition?: 'left' | 'right';
  /** Single validation flag key. */
  validateKey?: string;
  /** Multiple validation flag keys — ALL must be true. */
  validateKeys?: string[];
}

export interface TutorialPersistence {
  active: boolean;
  currentChapter: number;
  completed: Record<string, boolean>;
}

export type TutorialFlagName =
  | 'schemaTypeClicked'
  | 'queryExecuted'
  | 'resultModeToggled'
  | 'searchExecuted'
  | 'nodeExpanded'
  | 'vectorTabViewed';

export type TutorialFlags = Record<TutorialFlagName, boolean>;

// ---------------------------------------------------------------------------
// Chapter definitions
// ---------------------------------------------------------------------------

export const TUTORIAL_CHAPTERS: TutorialChapter[] = [
  {
    id: 'what-is-a-graph',
    title: 'What is a Graph?',
    instruction:
      'A graph database stores data as <strong>vertices</strong> (nodes) and <strong>edges</strong> (connections between nodes). Each vertex and edge has a <em>type</em> (like "Topic" or "Entity") and <em>properties</em> (key-value data).<br><br>The <strong>Schema Browser</strong> on the left lists every type in this database. <strong>Click on any type name</strong> — this will load some of that type\'s data into the graph canvas in the center so you can start exploring.',
    task: 'Click any type name in the Schema Browser on the left.',
    highlight: 'schema-browser',
    validateKey: 'schemaTypeClicked',
    cardPosition: 'right',
  },
  {
    id: 'storing-data',
    title: 'The SQL Workbench',
    instruction:
      'The tutorial created a <strong>Topic</strong> vertex and an <strong>Entity</strong> vertex for you when it started. Let\'s find them using the <strong>SQL Workbench</strong> at the bottom of the screen.<br><br>A <code>SELECT</code> query is already loaded in the editor. Click the <strong>▶ Run</strong> button (or press <strong>Ctrl+Enter</strong>) to execute it.<br><br>Look at the <strong>results panel</strong> on the right side of the workbench — you\'ll see a table with columns like <code>@rid</code>, <code>@type</code>, and <code>name</code>. The <code>@rid</code> value is this vertex\'s unique Record ID.',
    task: 'Click the ▶ Run button in the SQL Workbench to query the vertex.',
    highlight: 'query-workbench',
    validateKey: 'queryExecuted',
    cardPosition: 'right',
  },
  {
    id: 'relationships',
    title: 'Relationships (Edges)',
    instruction:
      'Edges connect vertices together. The tutorial already created a <strong>Topic</strong> and an <strong>Entity</strong> vertex for you when it started.<br><br>Now let\'s connect them with an edge. The command is pre-loaded in the SQL Workbench — it creates a <code>HasTopic</code> edge from the Entity to the Topic.<br><br>Click <strong>▶ Run</strong> to execute it. The result will show the new edge\'s RID.',
    task: 'Click ▶ Run to create the edge connecting the two vertices.',
    highlight: 'query-workbench',
    validateKey: 'queryExecuted',
    cardPosition: 'right',
  },
  {
    id: 'querying',
    title: 'Querying the Graph',
    instruction:
      'Now let\'s query the data you just created. A <code>SELECT</code> query is pre-loaded in the workbench.<br><br>Click <strong>▶ Run</strong> to see results in the <strong>Table</strong> view. Then click the <strong>JSON</strong> tab next to "Table" to see the raw data format.<br><br>After that, try copying this graph query into the editor and running it:<br><code>MATCH {type: Topic, as: t} &lt;-- {as: v} RETURN t, v LIMIT 50</code><br>If results contain graph data, a <strong>"View as Graph"</strong> button will appear — click it to visualize the query results on the graph canvas.',
    task: 'Run a query and toggle between the Table and JSON result tabs.',
    highlight: 'query-workbench',
    validateKeys: ['queryExecuted', 'resultModeToggled'],
    cardPosition: 'right',
  },
  {
    id: 'hybrid-search',
    title: 'Search',
    instruction:
      'The <strong>Search</strong> bar at the top of the left sidebar lets you find vertices by name or content.<br><br>Type <strong>graph-tutorial</strong> (the topic you just created) into the search box. Results will appear automatically as you type — no need to press Enter.<br><br>Each result shows the vertex type and name. <strong>Click on any result</strong> to navigate to that node in the graph — it will be highlighted and centered on the canvas, and its details will appear in the right panel.',
    task: 'Type "graph-tutorial" in the search box, then click a result.',
    highlight: 'search-input',
    validateKey: 'searchExecuted',
    cardPosition: 'right',
  },
  {
    id: 'traversal',
    title: 'Graph Traversal',
    instruction:
      'Graph traversal means following edges from one node to its neighbors. This is what makes graph databases powerful — you can explore <em>relationships</em>.<br><br><strong>Double-click any node</strong> on the graph canvas. This fetches all of that node\'s direct neighbors from the database and adds them to the view. New nodes will appear connected by edges.<br><br>You can also <strong>right-click</strong> a node for options like "Expand 2 hops" or "Expand 3 hops" to go deeper.',
    task: 'Double-click any node on the graph to expand its connections.',
    highlight: 'graph-canvas',
    validateKey: 'nodeExpanded',
    cardPosition: 'left',
  },
  {
    id: 'vectors',
    title: 'Vector Embeddings',
    instruction:
      'Some vertices store <strong>vector embeddings</strong> — arrays of numbers that capture the <em>meaning</em> of their content. Similar items have similar vectors.<br><br>Click the <strong>"Vector"</strong> tab in the tab bar above the graph. You\'ll see a 2D scatter plot where each dot is a vertex — similar items appear closer together.<br><br>On the right side of the Vector view, there\'s a <strong>similarity search</strong> panel. Type any text and click <strong>"🔍 Find Similar"</strong> to find vertices with similar meaning.',
    task: 'Click the "Vector" tab above the graph canvas.',
    highlight: 'vector-tab',
    validateKey: 'vectorTabViewed',
    cardPosition: 'right',
  },
];

// ---------------------------------------------------------------------------
// Cleanup queries
// ---------------------------------------------------------------------------

export const TUTORIAL_CLEANUP_QUERIES: string[] = [
  "DELETE VERTEX Entity WHERE name = 'Graph Explorer' AND type = 'tool'",
  "DELETE VERTEX Topic WHERE name = 'graph-tutorial'",
];

// ---------------------------------------------------------------------------
// LocalStorage key
// ---------------------------------------------------------------------------

export const TUTORIAL_STORAGE_KEY = 'kadi-graph-explorer-tutorial';

// ---------------------------------------------------------------------------
// Default flags
// ---------------------------------------------------------------------------

export function createDefaultFlags(): TutorialFlags {
  return {
    schemaTypeClicked: false,
    queryExecuted: false,
    resultModeToggled: false,
    searchExecuted: false,
    nodeExpanded: false,
    vectorTabViewed: false,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class TutorialStateMachine {
  active: boolean;
  currentChapter: number;
  completed: Record<string, boolean>;
  flags: TutorialFlags;

  constructor(persistence?: TutorialPersistence) {
    this.active = persistence?.active ?? false;
    this.currentChapter = persistence?.currentChapter ?? 0;
    this.completed = persistence?.completed ?? {};
    this.flags = createDefaultFlags();
  }

  /** Total number of chapters. */
  get totalChapters(): number {
    return TUTORIAL_CHAPTERS.length;
  }

  /** Serialize to persistence format. */
  serialize(): TutorialPersistence {
    return {
      active: this.active,
      currentChapter: this.currentChapter,
      completed: { ...this.completed },
    };
  }

  /** Check whether the current chapter's task is validated. */
  isCurrentChapterValidated(): boolean {
    return this.isChapterValidated(this.currentChapter);
  }

  /** Check whether a specific chapter's task is validated. */
  isChapterValidated(index: number): boolean {
    const ch = TUTORIAL_CHAPTERS[index];
    if (!ch) return false;
    if (ch.validateKeys) {
      return ch.validateKeys.every((k) => this.flags[k as TutorialFlagName]);
    }
    if (ch.validateKey) {
      return this.flags[ch.validateKey as TutorialFlagName];
    }
    return false;
  }

  /** Set a validation flag. */
  setFlag(flag: TutorialFlagName): void {
    this.flags[flag] = true;
  }

  /** Activate tutorial mode. */
  activate(): void {
    this.active = true;
  }

  /** Deactivate tutorial mode. */
  deactivate(): void {
    this.active = false;
  }

  /** Advance to next chapter (only if current is validated). Returns true if advanced. */
  next(): boolean {
    if (!this.isCurrentChapterValidated()) return false;
    const ch = TUTORIAL_CHAPTERS[this.currentChapter];
    if (ch) this.completed[ch.id] = true;
    if (this.currentChapter < TUTORIAL_CHAPTERS.length) {
      this.currentChapter++;
      this.flags = createDefaultFlags();
      return true;
    }
    return false;
  }

  /** Go back one chapter. Returns true if moved back. */
  back(): boolean {
    if (this.currentChapter <= 0) return false;
    this.currentChapter--;
    this.flags = createDefaultFlags();
    return true;
  }

  /** Skip (advance without validation). Returns true if advanced. */
  skip(): boolean {
    const ch = TUTORIAL_CHAPTERS[this.currentChapter];
    if (ch) this.completed[ch.id] = true;
    if (this.currentChapter < TUTORIAL_CHAPTERS.length) {
      this.currentChapter++;
      this.flags = createDefaultFlags();
      return true;
    }
    return false;
  }

  /** Restart tutorial from beginning. */
  restart(): void {
    this.currentChapter = 0;
    this.completed = {};
    this.flags = createDefaultFlags();
    this.active = true;
  }

  /** Check if tutorial is complete (all chapters done). */
  get isComplete(): boolean {
    return this.currentChapter >= TUTORIAL_CHAPTERS.length;
  }
}
