# **Strategic Refactoring Architecture: Transforming AST Impact Mapping for Agentic Workflows**

AI agents frequently encounter a critical "perception gap" when executing code modifications across large-scale codebases.1 While an agent can comfortably process local Abstract Syntax Tree (AST) nodes within a single file, it remains functionally blind to the recursive, transitive ripples propagated across complex, multi-package monorepos.1 Without a programmatic mechanism to map these ripple effects, agents are forced to rely on coarse text searches or brute-force executions of entire test suites, leading to severe resource waste and integration failures.1  
To bridge this gap, the ast-impact-mapper-mcp must transition from a local, single-project parsing paradigm into a high-fidelity, monorepo-aware network topology.1 By providing agents with a real-time, compiler-validated "sonar" of code dependencies, the Model Context Protocol (MCP) server enables safe, autonomous, and token-optimized refactoring at scale.2

## **High-Fidelity Monorepo Awareness and Boundary Mapping**

Scaling AST analysis across modern monorepos managed by Turborepo, Nx, or Lerna presents a significant computational challenge.7 Eagerly loading a repository containing over 5,000 files into a single in-memory ts-morph project inevitably leads to Node.js Out-of-Memory (OOM) errors and prohibitive startup latencies.10 The compiler-driven mapping architecture must utilize TypeScript Project References and package manager workspaces to achieve isolated, incremental graph building.9

### **Leveraging Project References for Boundary Mapping**

TypeScript Project References mandate that sub-packages compile as isolated, independent units with composite: true enabled in their respective configurations.10 This architectural setting forces the generation of .d.ts declaration files and .tsbuildinfo incremental build caches.10 The impact mapper leverages this compiler contract to scale its analysis.9  
Instead of parsing raw source code across package boundaries, the impact mapper treats upstream packages as abstract, type-emitted modules.10 When a change is detected in a core library (e.g., @my-org/core), the mapper inspects the package's generated declaration maps (.d.ts.map), enabled by declarationMap: true.10 The downstream consumer application (e.g., @my-org/app) resolves types against these declaration files, allowing the mapper's underlying engine to traverse package boundaries without eagerly parsing the raw source files of @my-org/app.10  
The system constructs a workspace-level package dependency graph by parsing the root package.json workspaces alongside the top-level project references arrays.7 This yields a dual-layered mapping strategy, detailed in the comparison below.

| Mapping Attribute            | High-Level Workspace Dependency Graph                                 | Low-Level AST Reference Graph                                   |
| :--------------------------- | :-------------------------------------------------------------------- | :-------------------------------------------------------------- |
| **Primary Sources**          | Root package.json Workspaces, Root tsconfig.json Project References 7 | Local AST Parser (ts-morph), .d.ts.map Source Maps 10           |
| **Parsing Resolution**       | Coarse package-to-package connections 14                              | Fine-grained file-to-file and symbol-to-symbol relationships 15 |
| **Memory Allocation**        | Near-zero, parsing metadata files and manifests only 7                | On-demand allocation for affected sub-package AST nodes 10      |
| **Execution Cost**           | Negligible (milliseconds) 14                                          | Moderate, optimized via file-timestamp MD5 hashing 16           |
| **Role in AI Orchestration** | Filters the search space to relevant package subtrees 8               | Resolves target impact chains and guides symbol-level changes 1 |

Through this layered approach, the impact mapper isolates the execution context.8 When an agent modifies a symbol in @my-org/core, the mapper first queries the workspace graph to identify dependent sibling packages.10 It then loads only those target packages' AST contexts, navigating their external imports to locate downstream consumer files.8  
This process can be augmented by integrating workspace-aware configurations.7 For instance, a centralized monorepo configuration utility can generate a tsconfig-leaves.json file at the repository root, listing all leaf projects that do not have downstream dependents.7 The impact mapper can utilize this list to terminate its transitive dependency searches early, optimizing path resolution across deep project hierarchies.7

## **Semantic and Symbol-Level Impact Analysis**

File-level dependency mapping is highly susceptible to false positives.2 If a test file imports a single helper from a utility module, any modification to unrelated functions within that same utility module will trigger redundant test executions.3 Moving from file-level import tracking to a symbol-level directed graph resolves this redundancy.15

### **Transitioning to Symbol-Level Graphs**

To establish a symbol-level graph, the impact mapper maps structural code elements into unique identities defined by a module path, file path, and symbol identifier.15 The system parses the source code using the TypeScript Compiler API 18, leveraging the AST structure where declarations represent nodes and call-sites or type usages represent directed edges.15  
The architecture of a symbol-level dependency graph follows a hierarchical structure:

       |
       v

\[9, 15\]  
 |  
 v

       |
       \+---\> \[Function Entity\] \-\> Identity, signature, call-sites
       \+---\>     \-\> Identity, declarations, type-usages
       \+---\> \[Variable Entity\] \-\> Identity, mutations, access-sites

To build this graph without incurring global compilation costs, the mapper scans files to identify exported identifiers.18 For each exported symbol, the system queries the TypeScript Language Service APIs, specifically findRenameLocations or findReferences.20 These APIs resolve program-wide references to that specific identifier across the workspace.22 This ensures that if an agent changes the implementation of a specific exported function, the mapper traverses the reverse reference edge to isolate the impact solely to the test files that import and execute that specific function.1 This leaves other tests unflagged, bypassing unnecessary test runs.1  
The system can employ a custom resolver to track these relationships, matching files and extracting metadata into structured nodes.14 This approach mirrors tools like skott and Knip, which construct internal module graphs to identify unused exports or map workspace-wide imports.24 By integrating these custom resolvers directly with the TypeScript Compiler API, the impact mapper can track symbol flows while skipping non-standard or third-party files that do not affect the internal dependency chain.14

### **Identifying Side-Effect and Architectural Context Impacts**

Standard static import analysis struggles to capture implicit dependencies that bypass ES module import paths.19 These side-effects typically manifest as global variable modifications, CSS-in-JS style mutations, or React Context provider consumptions.27

#### **Global Variables and Window Mutations**

Global variable side-effects are analyzed by scanning AST nodes for assignments to properties on global interfaces or the standard execution context (e.g., window.themeConfig \=...). When the compiler identifies global mutations, the mapper marks the mutating file as a "Side-Effect Producer." Downstream files that access these global properties without formal imports are identified by resolving unbound identifiers against the global environment, mapping them back to the original producer.

#### **CSS-in-JS and Shared Theme Variables**

CSS-in-JS frameworks rely heavily on global or context-driven theme configurations. When an agent alters a theme configuration block, the changes are tracked by scanning the codebase for components consuming the theme type definitions or structural layout patterns. This mapping compiles style dependencies into structured architectural contracts, tracking changes across SCSS classes, Tailwind utility usages, and CSS-in-JS variables.29

#### **React Context and State Propagation**

React Context dependencies are modeled by analyzing hooks that consume context providers.28 The mapper scans AST patterns looking for instances of useContext or custom context hooks.27 By identifying the specific context identifier (e.g., MyContext), the mapper associates the consuming component with the corresponding MyContext.Provider node in the dependency graph.27 If an agent alters the type signature or structural contract of the value supplied to MyContext.Provider, the mapper traces this change directly to all components invoking useContext(MyContext).28 This allows the mapper to flag components for verification even if they have no direct file-to-file import relationship with the file that modified the provider.1

## **Intelligent Refactoring Orchestration and Dead Code Removal**

To support automated refactoring, the impact mapper must provide predictive analysis before code modifications occur, and execute safe structural cleanups afterward.24

### **Change Propagation Simulation**

Before an AI agent initiates a structural refactor (e.g., renaming an interface field or altering a function signature), the impact mapper calculates a "Blast Radius Metric." This metric provides a predictive score indicating the scale and complexity of the proposed modification.  
The Blast Radius Metric (![][image1]) of a proposed change is computed using the following equation:  
![][image2]  
Where:

- ![][image3] represents the set of all transitively affected symbols identified by the reference-tracking resolver.15
- ![][image4] is the reference count (call-sites, imports, or type instantiations) resolved for symbol ![][image5] across the workspace.22
- ![][image6] is the semantic type multiplier, calibrating impact based on the architectural role of the symbol 15:
  - ![][image7] (high-risk structural providers) 28
  - ![][image8] (type contracts) 15
  - ![][image9] (UI modules) 16
  - ![][image10] (file-local entities) 19
- ![][image11] is the count of unique physical files containing at least one affected reference.6
- ![][image12] is the maximum depth of the transitive reference chain (e.g., ![][image13] yields a depth of 3).1
- ![][image14] are scaling coefficients calibrated to codebase complexity (default: ![][image15]).

Based on the calculated ![][image1] value, the mapper classifies the refactor complexity as detailed in the following table:

| Blast Radius Score (Br​) | Complexity Classification | Key Risk Indicators                                             | Recommended Execution Strategy                                                            |
| :----------------------- | :------------------------ | :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| **![][image16]**         | **Trivial**               | Local module scope, minimal downstream impact.3                 | Direct agent execution with standard automated refactoring.                               |
| ![][image17]             | **Moderate**              | Multi-file impact, limited package-internal exports.1           | Incremental execution, running targeted tests after each atomic change.1                  |
| ![][image18]             | **High**                  | Multi-package boundary crossings, public API contract changes.8 | Comprehensive review of the generated dependency graph before modification.1              |
| ![][image19]             | **Critical**              | Core system interfaces, global contexts, or widely used types.8 | Manual human intervention, or structured agent refactoring using strict branch isolation. |

### **Feasibility of Automated Dead Code Removal Workflows**

Dead code removal requires tracing code reachability from defined entry points.3 Conventional tools like ts-prune identify unused exports but struggle with recursive cleanup.35 For example, removing an unused export may render its internal helper functions unused, requiring a secondary analysis pass.32  
Tools like tsr (TypeScript Remove) demonstrate the efficiency of this approach.3 Rather than merely stripping the export keyword, tsr walks the AST to remove the entire declaration.32 It then recursively traces local dependencies that were referenced only by that deleted node, removing them and their associated imports.32  
To integrate this safely into an MCP server, the mapper must establish strict safety boundaries. Static analysis cannot reliably resolve dynamic patterns, creating risk areas that require mitigation, as compared in the table below.

| Tool / Solution | Detection Mechanism                                                     | Removal Completeness                                                             | Real-World Failure Risks & Limitations                                    | Safety Mitigation Strategy                                                             |
| :-------------- | :---------------------------------------------------------------------- | :------------------------------------------------------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------------- |
| **ts-prune** 19 | Static export analysis based on tsconfig.json.19                        | **None**: Reports issues only, leaving removal to the user.19                    | False positives on dynamic imports and framework configuration files.19   | Support explicit ignore patterns (// ts-prune-ignore-next or configurations).19        |
| **Knip** 24     | Comprehensive workspace analysis of files, exports, and dependencies.24 | **Limited**: Historically focused on removing the export keyword.32              | False positives on reflection-based code or lazy-loaded assets.19         | Configure compilers for non-standard files and exclude known entry points.19           |
| **tsr** 3       | AST traversal using the TypeScript Compiler API.3                       | **High**: Removes entire declarations, local helpers, and imports recursively.32 | Destructive deletes on unreferenced test files or dynamic path imports.32 | Run dual-pass analysis: verify production entry points first, then check test files.32 |

The destructive delete scenario represents a classic program-analysis hazard.36 If an agent runs a dead code pruning tool on a codebase where test files are not explicitly imported by any production entry point, the tool may classify all tests as unreachable and delete them.32  
To prevent this, the mapper must implement a dual-pass resolver.32 The first pass maps and prunes unreachable exports within the production graph.3 The second pass resolves references against test configurations and workspace specifications, ensuring that any symbol utilized exclusively in testing is preserved.32

## **Token-Optimized Code Summarization and Structural Context**

To maximize the efficiency of AI agents, the impact mapper must optimize the context fed into LLMs.5 Providing full-text source files consumes excessive tokens and introduces noise.5 The mapper solves this by generating highly compressed "Skeleton Views" and "Breadcrumb Navigation" structures.6

### **Mechanics of AST-Based Skeleton Views**

A Skeleton View extracts the structural contract of a source file while discarding implementation details.5 By parsing the AST, the mapper strips away all function and method bodies, retaining only declarations, public API signatures, type definitions, and structural annotations.5  
Tools like ast-outline and LogicStamp show the high compression ratios achievable with this technique, often reducing token usage by 5x to 10x compared to raw source code.5

Raw Source File (\~400 lines of implementation)  
 |  
 v \[ast-outline\] \-\> Parse via tree-sitter & rayon concurrently \[6, 39\]  
 |  
Skeleton View (\~40 lines of structural metadata)  
 \+-- File-level stats & size classifications in headers  
 \+-- Public classes, method signatures, and decorators \[5\]  
 \+-- Preserved JSDoc comments & line range pointers (e.g., L42-58) \[5\]

By presenting the structural schema and mapping declarations directly to their physical line numbers, the mapper allows agents to understand the API surface immediately.5 If the agent needs to modify a specific method, it can target its file-reading operations precisely to that line range, preserving context window capacity.5  
Furthermore, tools like LogicStamp extend this paradigm by compiling TypeScript codebases into deterministic, machine-readable JSON bundles representing components, props, hooks, and styles.28 Rather than relying on raw code snapshots, LogicStamp extracts contracts.29 This structural approach enables strict watch mode execution and git baseline comparisons (--baseline git:\<ref\>) to assert architectural integrity, alerting the agent to any structural drift or contract violations in real time.28

### **Implementing Breadcrumb Navigation and Related Symbols**

To prevent agents from getting lost in unfamiliar codebases, the mapper provides "Breadcrumb Navigation." This feature maps contextual peer relationships by analyzing the symbol-level dependency graph.6  
When an agent requests analysis for a file (e.g., UserStore.ts), the mapper traverses the bidirectional graph to identify highly connected neighboring nodes 1:

1. **Associated Test Specs**: Matches the file against reverse-dependency edges ending in .test.ts or .spec.ts.1
2. **Contextual Consumers**: Identifies components that import or wrap the store (e.g., UserContext.tsx).28
3. **Co-Declared Type Aliases**: Follows references to dedicated type definition files (e.g., UserStore.types.ts).

By querying the global symbol table and tracking neighboring references, the mapper generates a structured navigation block.6 This prevents agents from making local modifications while ignoring downstream structural dependents.1

## **End-to-End Testing Ecosystem Integration**

An impact mapper reaches its full utility when integrated with runtime execution frameworks.1 By connecting AST analysis with test runners and diagnostic tools, the mapper creates an automated loop for testing and verifying code changes.2

### **Dynamic Test Command Generation**

Rather than executing an entire test suite, the mapper translates its dependency graph outputs into optimized test runner commands.1 For Vitest or Jest, the mapper formats the affected spec files into a space-delimited string 1:

Bash  
npx vitest run src/stores/\_\_tests\_\_/UserStore.test.ts src/context/\_\_tests\_\_/UserContext.test.ts

For Playwright E2E suites, this selective targeting is highly valuable, turning hours of CI execution into a rapid, targeted run.2

### **Integrating with Playwright Trace Decoder and Triage Tools**

When tests fail, diagnosing the root cause across distributed monorepo packages is challenging.33 To solve this, the mapper integrates with playwright-trace-decoder-mcp and flakiness-knowledge-graph-mcp under a unified orchestrator: release-readiness-triage-mcp.33  
When a failure occurs, the triage flow leverages these integrated signals, as compared below.33

| Triage Signal Source                 | Diagnostic Mechanism                                           | Token Optimization Strategy                                                | Primary Output                                                                |
| :----------------------------------- | :------------------------------------------------------------- | :------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| **playwright-trace-decoder-mcp** 33  | Unpacks trace.zip and parses internal JSONL events.4           | Translates raw DOM into YAML ARIA trees (\~90% token reduction).4          | Exact failing action, JS exceptions, and failed assertions.42                 |
| **flakiness-knowledge-graph-mcp** 33 | Accumulates run history into a local SQLite database.43        | Queries focused history metrics based on test identifier and commit SHA.43 | Flakiness classification: KNOWN FLAKY, MILDLY FLAKY, or NO HISTORY.33         |
| **ast-impact-mapper-mcp** 1          | Performs transitive dependency analysis of the active branch.1 | Resolves target files using the cached symbol dependency graph.1           | Logical verification confirming if code changes relate to the failing test.33 |

The release-readiness-triage-mcp orchestrator synthesizes these inputs into a final release recommendation, helping agents quickly distinguish between real regressions and transient infrastructure issues.33

## **Strategic Roadmap: Version 0.3.0 and 1.0.0**

To realize this vision, the mapper's development is structured into two major releases: Version 0.3.0 (Semantic & Token Optimization) and Version 1.0.0 (High-Fidelity Monorepos & Active Refactoring).

### **Version 0.3.0: Semantic Analysis, Token Optimization, and Test Integration**

Version 0.3.0 introduces semantic mapping, token-optimized code summaries, and runtime test execution helpers.

#### **Performance & Scaling Strategies for Large Codebases (5,000+ Files)**

- **Metadata Caching via Hashing**: Implement an MD5 file-content hashing cache stored in a local .ast-mapper-cache/ directory, similar to incremental compilation tools.16 The mapper only parses files whose hashes have changed, bypassing redundant disk read operations.17
- **Algorithmic Traversal Optimization**: Replace ![][image20] array-shifting operations in recursive dependency resolution with index-based traversals.30 This eliminates performance degradation in deep, highly connected dependency trees.30
- **On-Demand Subtree Parsing**: Instead of parsing the entire workspace on startup, initialize ts-morph with lazy-loading configured.17 The mapper parses files on-demand as traversals encounter them, minimizing memory overhead.17

#### **New Tool Definitions (Zod Schemas)**

##### **get_symbol_dependency_graph**

Retrieves a bidirectional dependency graph mapped to individual declarations, functions, and variables.

TypeScript  
import { z } from "zod";

export const GetSymbolDependencyGraphSchema \= z.object({  
 filePath: z.string().describe("Absolute path to the TypeScript source file"),  
 symbolName: z.string().optional().describe("Target export symbol. If omitted, maps all symbols in the file"),  
 direction: z.enum(\["forward", "reverse", "bidirectional"\]).default("bidirectional")  
});

export type GetSymbolDependencyGraphArgs \= z.infer\<typeof GetSymbolDependencyGraphSchema\>;

##### **generate_skeleton_view**

Generates a token-optimized representation of a source file by stripping function and method bodies.

TypeScript  
export const GenerateSkeletonViewSchema \= z.object({  
 filePath: z.string().describe("Absolute path to the target source file"),  
 includeJSDoc: z.boolean().default(true).describe("Whether to preserve JSDoc annotations"),  
 includePrivateMembers: z.boolean().default(false).describe("Whether to list private/internal symbols")  
});

export type GenerateSkeletonViewArgs \= z.infer\<typeof GenerateSkeletonViewSchema\>;

##### **generate_test_command**

Outputs the optimal test execution command for Jest, Vitest, or Playwright based on changed files.

TypeScript  
export const GenerateTestCommandSchema \= z.object({  
 changedFiles: z.array(z.string()).describe("List of modified source file paths"),  
 runner: z.enum(\["jest", "vitest", "playwright"\]).default("vitest")  
});

export type GenerateTestCommandArgs \= z.infer\<typeof GenerateTestCommandSchema\>;

### **Version 1.0.0: High-Fidelity Monorepos, Change Propagation, and Active Refactoring**

Version 1.0.0 delivers full monorepo support, change propagation simulation, and safe, automated dead-code pruning.

#### **Scaling Strategy: Package-Level Boundary Pruning**

To scale across monorepos containing more than 5,000 files, the mapper implements a package-level boundary pruning strategy.10 The system reads the root project references and maps the workspace topology.7 When a file in package ![][image21] is changed, the mapper resolves downstream package consumers (![][image22], ![][image23]) by analyzing package manifests and declaration maps, avoiding eager parsing of downstream packages.10 The detailed symbol search is restricted only to those packages, protecting system memory.8

#### **New Tool Definitions (Zod Schemas)**

##### **simulate_refactor_impact**

Calculates a predictive blast radius and complexity report before executing structural code changes.

TypeScript  
export const SimulateRefactorImpactSchema \= z.object({  
 filePath: z.string().describe("Path to the file containing the target symbol"),  
 symbolName: z.string().describe("The name of the class, function, or interface being modified"),  
 modificationType: z.enum(\["rename", "signature_change", "deletion"\])  
});

export type SimulateRefactorImpactArgs \= z.infer\<typeof SimulateRefactorImpactSchema\>;

##### **prune_dead_code**

Safely removes unused exports and recursively deletes declarations and imports that become dead as a result.32

TypeScript  
export const PruneDeadCodeSchema \= z.object({  
 entryPoints: z.array(z.string()).describe("Monorepo execution entry points used to trace symbol reachability "),  
 dryRun: z.boolean().default(true).describe("If true, returns a report of deletable code without modifying files"),  
 recursive: z.boolean().default(true).describe("Recursively trace and delete local helper functions ")  
});

export type PruneDeadCodeArgs \= z.infer\<typeof PruneDeadCodeSchema\>;

## **Agentic Prompt Patterns: Safe Refactoring Context**

To ensure AI agents utilize these tools safely, they must follow structured prompting patterns that enforce analysis before execution.

### **System Prompt Directive for Refactoring Agents**

You are an expert software refactoring agent. You operate within large-scale TypeScript monorepos and must never guess the downstream impact of your changes. You have access to the AST Impact Mapper MCP server, which serves as your program-analysis sonar.  
Your operational workflow for executing any code modification is strictly defined as follows:

1. **SIMULATE**: Before editing any file, run simulate_refactor_impact. Review the Blast Radius score, the count of affected files, and the complexity classification.
2. **OPTIMIZE CONTEXT**: If you need to inspect an unfamiliar downstream file, do not read the full file. Run generate_skeleton_view first to understand its structural interface and locate exact target line numbers.
3. **CONTEXT INTEGRITY**: Prior to modifying any shared context providers or global variables, query get_symbol_dependency_graph to locate consumer hooks and implicit architectural dependencies.
4. **EXECUTE & PRUNE**: After completing a refactor, if you suspect any local variables, helper functions, or exports have been rendered obsolete, execute prune_dead_code with dryRun: true. Review the report, confirm safety boundaries, and execute the prune.
5. **VERIFY**: Run generate_test_command based on your modifications, then execute the generated command to verify your changes.

### **Multi-Step Agent Interaction Flow**

#### **Step 1: Pre-Refactor Impact Analysis**

The agent needs to change the signature of getUser in UserStore.ts. It invokes simulate_refactor_impact before making any modifications.

##### **MCP Tool Request**

JSON  
{  
 "name": "simulate_refactor_impact",  
 "arguments": {  
 "filePath": "/workspace/packages/core/src/UserStore.ts",  
 "symbolName": "getUser",  
 "modificationType": "signature_change"  
 }  
}

##### **MCP Tool Response**

JSON  
{  
 "blastRadiusScore": 45,  
 "complexityClassification": "Moderate",  
 "affectedFilesCount": 3,  
 "affectedFiles":,  
 "riskFactors":",  
 "Symbol is utilized within a React Context Provider.\[28\]"  
 \]  
}

#### **Step 2: On-Demand Downstream Analysis**

The agent sees that UserProfile.tsx is affected. Instead of loading the entire 800-line UI component into memory, it calls generate_skeleton_view to locate where getUser is used.

##### **MCP Tool Request**

JSON  
{  
 "name": "generate_skeleton_view",  
 "arguments": {  
 "filePath": "/workspace/packages/app/src/components/UserProfile.tsx"  
 }  
}

##### **MCP Tool Response**

YAML  
\# File: /workspace/packages/app/src/components/UserProfile.tsx (Lines: 1-120, \~65 tokens)  
export interface UserProfileProps L12-15  
export function UserProfileComponent(props: UserProfileProps): JSX.Element L18-115  
 const { getUser } \= useUserContext() L24  
 const \[user, setUser\] \= useState\<User | null\>(null) L25  
 useEffect(() \=\> { getUser(props.id).then(setUser) }, \[props.id\]) L28-30

#### **Step 3: Targeted Verification**

The agent completes the signature modification in UserStore.ts and updates the usage in UserProfile.tsx (specifically at line range L28-30). It now calls generate_test_command to verify the updates.

##### **MCP Tool Request**

JSON  
{  
 "name": "generate_test_command",  
 "arguments": {  
 "changedFiles":,  
 "runner": "vitest"  
 }  
}

##### **MCP Tool Response**

JSON  
{  
 "command": "npx vitest run packages/core/src/\_\_tests\_\_/UserStore.test.ts packages/app/src/components/\_\_tests\_\_/UserProfile.test.ts"  
}

[image1]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAZCAYAAAArK+5dAAABBUlEQVR4XmNgGAWDDbQA8Ucg/g/F34H4PRB/AOK/ULFncNUUAJgF6ECKASL+BV2CVAAyZBO6IBTgspxo4McAMcAAXQIIBBkQQUc2OMuA24Uw1zOhS5ACYIYoQ7EGEPdDxVYiqSMbgAzaB8QuQOwMpeOg4luR1JEFYOFviC4BBOwMELm76BKkgPMMuMMfBChOQSDNn9EFoSCFASJ/FElMHoi5oOwoJHGsAJaJytElgMCIASL3G0mMD4jloOJrgTgfiPciycMBKCJPMiC8fwOIDzJAFINomPgEmAYoABUrIAALMpA5MN9QDagD8Sd0QWqCZQzYg5RqABQ8LOiC1ATa6AKjYAQCAJk9QeDAih9XAAAAAElFTkSuQmCC
[image2]: data:image/png;base64,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
[image3]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADkAAAAaCAYAAAANIPQdAAAB+UlEQVR4Xu2XSyhFURSGF6K8388yNTEwU+QxMTBhwtAjUwMZMJGhGQZmZOCWJImJkoGhlPKcSEpJZORRQsjjX+29s8663LqlOMf56uuutfY+9551z96nc4hCQgJBBZyCLaI2IGJfkwzf4DTMgg3wHQ7DOzHP13BDdbpIpj6ki34kQqaZr+A6X2Xfw43EajIQuCbH9UCQGKXPRp2TnhkBoY+iGz32zAgYTRS9TyNwQ+S+ok0XLLPkbbIddoj8t0iHlboYi1bYr4uWQfqbd9ZVirPJHbisi5ZX8t585PJ1cTZcI/NEVAsX4Dy8tPMYN3eFzG/xUxUf53iBvfCKvA8jKWSOG4HPMAk+2preSjFxkzNUfYmiH+XKyPvFHC/aOEGNHcFmkcuxXJXfi1h/f6qNz2C5qMd1Jc9hIrwlc/CN/YyIOY48ij6JEpU79mCnyPW/znmhjfn3x+ChrTOZItbE3WQ86CvAcb7KHduwS+T6hDkvhjVklq+sM2ki1vD8KhvLZf8jfHUl+URl7tiF3SKXY3yCLud5MzbmPcf1UptzzK99Dve6dwHryfwRvE1+jAIyS5lvDvvwycZcKyKz3DnnGwNfxWs71sMHkznhObgOT2zNwVtmE06Q2SbyAeQAnpI5zpEDH+CWqP0Jvlt6gaGRTJPVeiAkJOR/8QH4EI1Q5pXCTQAAAABJRU5ErkJggg==
[image4]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABcAAAAaCAYAAABctMd+AAABCklEQVR4XmNgGAUDDXqA+CMQ/4fi70D8Foh/I4kpwBSTC2AGoYM9DBBxZXQJUgDIgKPogkDgxACRu4ouQSyIYIAY4IIuAQSzGCByC9DEiQbXGLAHCQjgCi6iATYDDID4DxA/QBMnGYAMBqWQU0B8AYh/QsXYkRWRA2DhDYo4ZHAdKk4RuMmA3ZAOBoi4GLoEKQBbeIPAFwaIOCO6BCkAZMAxdEEG3JaCgCcQ3wLiJ0DMiSYHB9UMEAN80SUYMA3Hxl4KxOFI4mAwBYg/A/F7Bkgq+QDEf1FUMDDoMEAMecYAKW94keRgFqchiVEFwIIhiQF3sJENsAUP1cBeID4BxDcY8ETmKBgFhAEAXOFJZHewavYAAAAASUVORK5CYII=
[image5]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAZCAYAAAAIcL+IAAAAdElEQVR4XmNgGAW0AolAvAyIbdAlkMF/IFaAsiuBuAohhQD7gPgEEh+kqROJDwefGCCS84FYFk0OBWgyQBTC8HtUaQiYC8QdSHw5BohiDAAS3I7EV4eKYYDvQJwPxEIMkOABKQKxsQIeII4AYjV0iVFAPQAAyIQVuMnEzLsAAAAASUVORK5CYII=
[image6]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAaCAYAAABYQRdDAAAA0UlEQVR4XmNgGAWjYGgCVyDeAMR56BLkABMg/g/EDlB+FZQPA9OQ2EQBXQaIAUJo4iCx1VD2X2QJYgBI8wt0QSD4xwCRMwfiaDQ5vMCBAaLRHU0cBB4xQOSQg4EoAPIeLk3XGCBykugShEADA25DLzLgllvMAEklv9AlYACkURVN7B4Qr4XKgUAfkpwmEC+CskHhjhWAYh0Uu7Dwm4Ekdx8qFo8kpgYVA+kRQRKnCHABMS8Q9zDgDh6SgBsDqpc/IbEpAh+AeB8QH0KXGAUjHQAAIJUvQF5JpHcAAAAASUVORK5CYII=
[image7]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJwAAAAaCAYAAABCUTWIAAAElElEQVR4Xu2aWagdRRCGyw3UKIoKcUHB7cEdg6DGJRFcEAVRVAg+3Bef8xIVNSpR8EFBURARV9xwF0VUEB+i4gZRXFAUl2uMirjv+1Yf1cWp6TtnzpmTXLkJ9cFPeqq6Z/pOV3dXz4lIkiRJkiRJkiTrA0+r/lX9qJqqfMM4WKzdAtXGqj1U16geiZWSpOZ31SalvLVY4H08cA/lWLG6UV80aiRJxSVigXJxsHnwjGKR6nHVzarLVFs13UkykwPEguvkYBs34I5UXVob1wXHie3LS2tHskHiudwojpB1HHCHiD18cbm+sFw714dysv6zjep71S+1YwiHq+4Wi4l7xNo926jRA19qt6vs2B4o5b+jYw6yj9jpaUPhQNWdQ3SH6nbVbapbxfKqm6zZWJDD3aj6VcZfSDidrq5sxMdzlW0saPh5bVT+EfMdqjqr8tUcpPpS9XztqNhd9Ynqw9oxguVifWHLj3ykelVshd5f9Y7qt1gh6WTcHK4NYqZ328VijU6o7MBxuU+HzpDRAQfkA30DDt6SZsCxrLfN7HH72wWTbW2Zp9qvNs4xHpPBNtmXlWJt51f2Ttgyhw3Q22K+nWrHEE6V8QKOfGCSgHtdBgF3kgzv98+1YQKG3bsPT8jkAcdOcGVPjeI11Q+V7SKxv/XPyl7TtvCsKrbNK3snK2TmjRwGuM1HHvGU6jvVuzKoUwfc2WIn3mtV9wU7Afep2PZH/sEW6xylelR1herrYIcYcARsW99g71Bu68OOYm1JAZ5UPaT6oPh4ef5yUZz55Dznig3ORmL5j9fbNZSnS914n7mA92XLYLur2O4Ntp3FxjJCHc/nnT+KvTc0ioMEDCgD4Te8uvzLYHmOtJk0HxgDjpwuJpnnqa4q5cOkuQodLTb4sELsAyXwaeaZUoYYcDz3r+Bro6sPu0mz79xrr3Bdv0hWBn7eAdKP94KPugTqm8Hm9klXuNlgjcxcCdsmRJuN1ZFUyGHXo85UsI0Np1NOof6gG4Jvutj8xpyevDNbSPNYTcC9UMrvqy4PPl68tyPg6qU9/oH7qh5WfSPNrZeAO76U8dcvxeFEBV19YBbH9kwA+uXU9+aaAXNF/w7luu2UP5cCDnzX8p2p7bB4vrT/Ruoplq9s/Nz1v/CS2Evndzm2FoeAe7GU2aKuCz7/zgddAcd9WVmBL+LTpQy8LD/cbC8zg8IhEYauPpDoxvb0py3g+PwQr9tgi3pFBn+7w8GDVRb47pVMyC21oXCm6uVS3lP1bfDx7chXGwY2fro4TfVGKTOwHsQEC1sisxGYYSeWMpBfMdsim6qWlXJXHzzncn5SLQzX7vN+3q86p5TB+wSegxK0vgIDeSo5KQEZJ2bSEwYjaonqdLHBZRv0bXWR2Fb9leqYYgMCbhex7ZJA4zTnMECsDAQa/wWGLXtKLIfg3jwjBh2rIM9YKbbKXBB80NYHtlPuw6GEVZrDD2Vsnqc8KHaooZ8O3wKp/1m5ZiXlvgQrsC3H623F+u+TMJkAPrLWdG03SbJWnCLNFYkEkwQ+SWYVkuD6U0qSJEmSJEky+/wHYABQ6wRazJgAAAAASUVORK5CYII=
[image8]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHoAAAAaCAYAAAB4rUi+AAADQklEQVR4Xu2ZWchNURTHFxke8GBKkkflRREZS98DeZBHpSTFg4xRyPBgyoPxCSlzFBHJ9IRIypDiAZmFDJmVeVx/e213neWe893zfd8daP3q39n7v/Y+556z9tlnn3OJHMdxHMdxHM1s1mRrZvCGtYzVndWCNZB1KdHCqRl2s76wfoqmJMOZxD5asxItnJqkIYmez9rBmmRiTg2TN9HfrNFYhrMOsmbYgNOk5E30V2s0lH4UDl4n9QVSj2xQZafx5E30Z9Z61lvWHgr9BydalEAvCh07GB/ePil/14EKg1VmM2uWmU2snSnCc3I7aytri7Qd+btX6eDaTrVmBu9YI1S9PxXPWSbo8NSazA8KsQGsscrXd3q5uUPhlaKSx6wEOJ/p1swJ9oEBUBJ1FDro0RJ5QCFmL/IZU8/ivDVy0JoKx26nA/8BOK8866CW1qDiuUkFU3Na42sUYl1tIAdp+y6F9pRjxDYxS1krc2hU6FYyuC4zrZnCOArt5xg/V6IXU3rjK/R37KN4cYTFg61i7WK9El/HoCfKf8haJD6SOUjKJ1gXKCw8gO4PprHWsDazbosXmci6ylrOuq58/F5cIKxaK/2czwLnlPbBYzSri6pPoNC+m/IAvJvGywQdehjvLmu/xMBaFYOnpxLUW0kZycJF1zHNOSqcYFsqvB9iBRnbrpMtBoHuf5IKj5gDrCVS7knJxeIH2WI26CNl9Lsl5WrTicJ5rbYBCoNRD+6IrR8p4tULVm64UPEAG1XsnnjjlVcs0ZGjrHmqbn8M6o8o3NVQjOPb7ePYSLCJBkNZx1jvKax6wUXW8T8tCqBvPI4+VrXAY/I5Fc4f22cUPotq8B0D38I1cXDg9QpbzFRln6GyEn2Iiid6rqp3lrIGib5vPJto3P1xP7gbtkn5NOuUlDXVTuw/T1aiMaXgY0skxs7KFh8JMBgiWPCBIRRW+ZqOlNy3Ll+m8D6LO7uNiY2R7V5K3hk3VNmpByyUXlL42wxg+4LCBT9MYTEGLZT4Cgp36jCpA7yT4x0d01ZzCkl+TWG/8fmKqSp62DfAeyceMTgekot99JYY1hifKCwg+4oH8Dvwm+1jwXEcx3Ecx3Ecpwn5BaAC8IQCmT/+AAAAAElFTkSuQmCC
[image9]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIkAAAAaCAYAAACD1n8kAAADtElEQVR4Xu2ZaahNURTHV+aQIjIrRSkpRYjU+yKKL8gQ8YryQfGSb0peiiRTPkiZoyiUpBBCIkOSWTJkJvM8D+tv7fWsu985796jdK/31q/+vb3/a+9z3j1rn733OYfIcRzHcRzHcQpnKus96ydrXxTLxxTWI9Y31qIo5tQSzrLKQ7k+yUCBGle1SGcH66Gpb2G9MHWnFlCP9ZXVxXjNSAbJF+OlgXYNErxhkef8xyCZOnNYkryYFZTcBt6N2MzCENYu1sw44BSNdayukVfIIMFMk9SmkL6J9CXpWBbqc0JdWWXKTnFpSpKbe3EgIm0wpPk10oukU6vIh7c9lL/bgJPK5hq0ibWRtZ5kdljD6va7VzY+UGFJThsMaX6NoMPj2GR+kMT6syZGMac4VJDkBE85+UgbDGl+KmUkHYZGPrhLf3HAWgJukFKjD2X7v/BeJCl3mXOK5SStwxWSWPs4UAdIuyb5WJxRPaVbXlqzPkZevj3JAUr+HfCyDDaqpOQDgfOUHMPbv8usBayrxj/GWkryz40M3jWSY2Dfc4r1gDWbNY9knX4X2gEd4StJ3iqibC/iANZp1nzWueC1I2n3lLWXtZN1M8QUXEycD+1assaHMm4QHOcw62Ro2yTEVFuDX0ywtLyMTaqemxmsRqau1yYGHnKQCXTqHnm3SC64nmRZ+NuDcjex2EQBvNnD61/lOatTKONYGBwKjokfAFZT7qvi+EdpXXf0Sj+SQQfwosnGMM3qhhDJnxXKzUMMTKbcPmnnLQXsoLWys0Fv41vQZpupD6fqbQoCTzVIvJ4EiVNuB6881M+wDv4JV4E2DU0dd6l+Y7hOcvcq9p9cTrLTV+IfgPoY1lrW8YQY6GDKAN84MOsA+PdJZhNI200gmeWUpPOWAnhg0LzE2m/aAcyyIyIP4H0JcoCZHv1ws/xTjrKOxCbJybFuKntYJ0IZS9JoE7MJWELySKjEyUF9FMlAupQQA21NGbyh3EHSxsSUcayLpp50XoDHVicj+t1A0RkCSZxrfMxMuqRgj4CkKLY/lrENpo6YfmuwSww82w9LG+4M0DmKYZ8zMJSns3abGDbjYBLl7qfSBsmnHNcpGOxfcPGwscVjmbKQZIOFfUqL4CER2J/AH8t6zXrGeksyQPBFEtKBguRUsg6FNha8mv7MusOaFjwsNTg2zoHYq1CGNyi0wZSNtfkJyQczLDXa5wLJUwPK6Ktgj4XlqKPxnBIhvqMdJwc8sWCQDI4DjuM4juM4Tt3mF83TIrKV3LbIAAAAAElFTkSuQmCC
[image10]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJ4AAAAaCAYAAABGpOW1AAAEFElEQVR4Xu2ZWchNURTHV8KTkilTeMCb6UHGB18yhjeePCiekCmS4cGXJ1MIGRKRsQwZU4aEZIgiUWT4zGTMPLP+9l596y7n3CluX9f61b9z1lp777PPOevuvc++RI7jOI7jOI7jlBvTWGOtMwejWY9Z31jzTMxxUtnG+sL6GTUuM5yVnaxHyt7Meqlsx8mLQhMP5Wsn+AYZn+NkpZDEW0qhvAW+m9ZZKP1Ze1gTbcApSwpJPJmeLTJlF0VXCpUroj0r2sJKde6UD4UkXlqCpflz0pFCxYbGD9+OeP5dB5ySsZa1KUUbWRtY61nrYtkhv2vlD97xeOtMIS3B0vw5QaUn1sn8oBDrzhqp/EVdpETMptA/LBnA8mh/Yi1TPtzb53iehm2rHMH9TbDOFNISLM2flQoKlQYaP7hHyY2eMnY2zllHCbhKmcnyhnVc2eAp64LxJWHbKjfwbvNdz2PfzuYCSMqRnGAqTat0jUKsuQ0UQFrb/5LL9GfiHVU2yDfxbFulZi5rQQEaFqrlDd7PZOtM4Qglv0/4MIMURCUlNwbw0G3sY/TVibZk+0L6czNRYhB2uoX7rDnR34DVM54fY52nMAU2i75nrEOsXaxbqBxpSWE0mkmhT3VVzCZLPonXhELfK1lXlF+3Jfeyn7WbwsOuH2PgJGsJhWm9Q/ShPNbH6Lt9ljUB9GmKdUYwBevnKu/EAt9U68wHVGxvfLcpvGy50GIVg08ST2zpIJJnjIlpzlL1jdajMHyDXlRddkU8tlY+gLLt4jk2LCWZOlFIViEp8a6zJim9pczE09c5Q9VrWtuWLocfjdjzWXtVTJeT81XKVxNoTKFvi2yA6UIhZt8ffmzblY2PGVsmb/A1i1+lXGi1it2JvlHKB9smnnCQNUPZtlOwH1AY9SCJ96DMv2JAC8qs/55COQG/wC2sh5RZDskyQNm5Rry2FOpLn16xtsaYbSvpfjBa4ojR2d6XlKlJYHmFvsp7wBHPA/t0Gsw+Q40PoNwNCmt93BsGkJKQLfH2UXLiTVc2XpQFCVVlfE0ps20kkCTeAQprUIAbt4mnP5ZQDyOxRieevY7GtmXLwZb6I0xMsHWcIsmWeEgIbD4LEjsdj9isRHIKkjy9KXxFa1pRZtvvKEzJAP428Xx4tNdEG20OjucAiXdC2cCu8b6yGilbNlVtW7o/nZWN87sqhn02wRPvL4C11AvW62jj+JzCNIhFNxboEPbAANY+Vax+0QZYP2GtgJdfi0LSYXpDux9iGUyz4sM1cR2cw4fymGbhv8jqS6Et7MldonB9lEPCoF+oBx8W/UD78GEiYFTE1HM42rYtgCTC9I6pW3/sAFmnIgExCgLpN9aUjlM0Pno5JacPhcTrZgOO4ziO4ziO87/zC56wXLnpQ1KFAAAAAElFTkSuQmCC
[image11]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADkAAAAaCAYAAAANIPQdAAAB70lEQVR4Xu2WSyhGURDHp0RKsrO2oLCQslRWipUte+zYybMURQllZyNSSlGSV8gzWSDFQhQLFlLej7zy/E9nDuP4+nykuNxf/bpzZs6tO/ecc7tEPj4+v5lx+BSinidYIz3wzk16jTAyDS66BSEazrpJr1FCpslsJx8p1xhYqwte5Izeb9VKGC9xOIxSNU/insdkZ+x57HkM5J+hjExDOSqXAnvVmPF00xf0voFCmOTk5pzxT7HgJkLBa1vz088aQeamj97ONZl5/JVl7ItphF3wgczZXoWbsF7mVci8QXgAl+CK1Jgi2Azb4JbKM/lwDdbBdcnp78We5D6khcwNuW4hALpJO+aXxEzCG6dmqYbTarwMRyWeglkS98EaiRPJvDjLlYpDXsluMmfxBB7BUzIP2aonOQRq0jIMq9RY13g1B9SYfzh0PQOOwEvYLjle8YmXGW8JucmvEKxJbqJcjXWN87rJdHqt38NSiZtgh8T8CzkjsYu91973rQRrcojMH5LFbZK3qGWHzOoyeh6f1U4yK8p/V7qWp2Kbn1e5b+GWXrc1w9dDMg/EH5VjkbcsHwOunctcbnIM7sNdWCB5ppjM2eP53NgjTJVaApkjxB+zNMkxDXAbZqrcj8MrrLfrnyMW9sMNGPe25OPj8594BmBLlG6+2Bg6AAAAAElFTkSuQmCC
[image12]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAAaCAYAAAD8K6+QAAAB9klEQVR4Xu2Wu0skQRDGiwtEfCAGmpgYi8nFJhoohoaCoUZmRnoe+AhM/AOEC487MDEQH6CIKGIgiGDkKQoiKvhCVDzujvP06qOrtbbs3R3YXZmV+cEH1V/1DFXTMz1NlJCQ8JaMs25ZT6JfrGvj/XieXYT4JkL8ofS52IPC16wpVJDLjxg/9nSSK7zFJhSZVjS27FD2oouysShFR5kTO1DwqjUVbeTmFNXu6L+vZuNr9snNqbUJ5gu5XJlN5Mg65fiG7FH2GyD/z5qKfDT2aA3KXldGsn07fmP5YBOKfDQWqiHkRQYXp/t/jZLLN9oEc8b6xjqg140ds4bFr2Z9kniWdcnaZG3L3FLJeU2KDzAeY30ndxqKzGdyF7cav4Pckeqv8T13rAY11o1tsPokxo/9QeIh1orEYIu1oMah1YFXIvEyq1vlgkyQ+2b0k0IBODrhrIgn5G8YwhahG0N8Qm7VID8XqzYjMWhXOWDvCbQ3z+pX44Jgi8C4XMU1KucZoNTGmijc2NeAB3At7lFQ7lkf1RgFVEncS6kNYPMBKAqvn+eI3Cp6fBO/Ax6YYw2qccE4ZC2JUABUKbkuctv3Ob3spmhskXXBOmX1iO+ZYu2y6mR8w7pi/SS36WDzgLAvxAo8bb2S7wKcWKbJrUh9aiohIaFY+A90CZRiYQoWtAAAAABJRU5ErkJggg==
[image13]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAAAaCAYAAABvj9h3AAACsElEQVR4Xu2XS+hNURTGP+9nefQfMRERA69SZOCRpCSPUqIQEzNG9B+YSQYYIBSmBiSMxNiEZKAkAzIwMPF+5c36rHPuPZZz79n73H39b1q/+jr3fGvfs9e9++y91wYcx3GcLrNK9MCaTjKGiNaLzoi2mdhic1+Ln5l6kWeiL2jm+E70IrvmXn+jdW8xF5rfD9E+0QzRjswbkV0nNlrX5Dx6ewDJZGh+e21AuAeNbbCBAeYaNK89NpCR5D8fLHqLRA/rIseh+TFfy2po7KYNDCBHoTnNt4ECXEU4MzviuWgoujuAB0UjrRnJd7TO7y40tsz4nfLZGoFsgebD/a4dV0THrBnDbNHF7PM3tP6DUnDJGpEwt5fWFBZBY/dtIAGbof9RLKGT4YZogjVjKHbCCjSk07qwEBlkzUDGQXM7JJommg5dmh5n/opm0+R8tUYFu/CPlvMDojWF+6vQjvsKXmq4DNYh30941OFgUStFZzN/SbNpcmaKbluzDU/RzLWrfDL3h6EdLzd+GaNEC2qKfexEHO32vwvQ2DwbKIGz1+YTok3QYwwHs4rQ5bMjHkIrz6I+QjveXWjXivGitTXFPvYjDn7njTUz8mdyP6liIf7OJ0TboX0sRTWhA3hCNMaaIUwS3bKmMAfa8TkbSAgLpdh9sA+aFw/BZbAIY3yrDSRiLPSFD+UJwgaw7nbS8uHDobE7NpCIR6Jh1gzgNDSvsu/mx5+Oz1JtiH32FGhOJ41fhAVj2e9pC89hrAS5VJaRv+mxVVco160RSKslifso/dc2kBDWAzymxHIZmttGG4AWOVOtWcUp6A/lyZ8D+P7P8O/pnMe5H3Kp436RiiOi0das4AM0D86AfBDz2caXjOfKWY3W3aH2MiesQzPnV9mVlb7jOI7jOI7jOI7jOP8zvwDv1Ll3egAsmwAAAABJRU5ErkJggg==
[image14]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACIAAAAaCAYAAADSbo4CAAABZ0lEQVR4Xu2Vu0oDQRSGjzcMBEtBrQUfwcYgipVgbyeClY2CjaAi2Igo2KiIjyD4Dt4aX0DxQvABtBBDKm//YWbM7L+bySawgcB+8MPsd3bDmdmZjUhOBzKAHCFrXGgn58i+HY8iv16tbawjE+S0kU1ymfPMQkwjOyyz5AQpshTTSBfLLHF7YRCZtOMvb9wMvcihmMkxQyyYK2RYTEMabaISuSMd81L7DRcfvo4wLckz14e2WQYoiHlmzHPvyKkd6ylc9moxrllYLpEqywBlpJul1Fah4QrXW64f5JNlC7whfcgBF5g7FhZt8JhlC1wgDyyZGeSFJViV5JXSXb/AsgEryAdL5hb5lui3QjeuNjHiOYc7CT1cCLAk8S92DDfrVzvW7P1X42wg98giFwI8sUii3okJMYuMswyQ9Ioj6P6YYpmCRxYB+sW8+iA3LFJQQrZYBtCNusuSmWORAv0baIYzFjk5Hcsfr+hDhvly3/EAAAAASUVORK5CYII=
[image15]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAI0AAAAaCAYAAACKPd9eAAADfklEQVR4Xu2ZS8iNQRjHHyEhcs19oWykKHJNfZGysmShLLBwi8glQoqN2xIL98uCXMpCWdi4ixAlhPSJBUmuud+ef887zpznzLzvmeM75+18Z37177zzn3nnzDvnmXln5hBFIpFIJFJXdGHtYC3XGZGIi+Osbcn1ENYfK6/WbGb9YP1kHVJ5WaxnfWB9Zs1Vea2FFawF2kzhHWsTaxCrHWsc61ZRiQpYzZqoPATNOuXVgveskcl1T5J2lBvA91nnrPQ91hUrXc8cZX2nQn8sLM5Oxdxja1lRiQp4rA2Sijdqs8qMZb0ieU0aRpO05bbluehK7uCC102bdU4lQbOGZNaep/IqYherszZJvqiNNqsMXkv4XswQNmZ0pHGH3GXg7dVmnRMaNHjNtyimo3uzmpJrfIm5rjUnSGYNm3KCxlfG52eBtRFGZlvld2B1Ul6tCQ0arA9blAusflToXATMp6IS+TKepF0IpjR8weHzfQylwj1G9oz71rrOi9Cg+cbaSbJePEZy/4SiEgFMJveMgko3aNPBkRRhlB5k7WftY+0h2ZWFgrb81qYDX3D4fB8oi34x3GU9TK4x62CXmcZwKu0Lo8Mk/XKApF/w2kS/hII2LtJmCthNTrXSY0jq6GF5ZXNRGwnnSbaseXOK9UubHnzB4fNd4IccqE0q3H+1yM0PtGexNgNBHQimYHydiZH9UZs1Bqt8nC+Uiy84fH4IJ0nWMjd1Rk7geZZoM4X22qD/6Jfr2khAZXgHZrE1UMPktkxw+NSsvKwHRJC7ysB7oM1AMKpRh16guxhMpc+dpVDwTEu16WEWSfmVyq8oaKawnmiTpDHBlbUgfUnWERrdprUqPYNKywB4o6w0FrWhh5YjyF13XqAtvsO56aw+VnoOSfkBlgfgPVJeJpdJ1gv2zqCJpLL+lldLcMRtRoDWNaucCWwcBNrAm2+l8beI/rHfJN4q5aeBBXxooFWLXiTt364zSH5L0182On3G4ZWFuak5uYa2/MvNB+wkdLAY4UTT5inJ9timI0nZGySz1VcqPaDErIHAeab8NHaT+wC0luDI4TXrBet58olBg78WbE6T/DdlYwINW258fqHSfikL386pUTirjRQqGpWtDaxnJmmzgZhN7q21jxg0zCVtNBgvtZECXmf2eqphmaaNiJeZrO7ajEQikUgkEolEIg3AXywD+zOgLlncAAAAAElFTkSuQmCC
[image16]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAD8AAAAXCAYAAAC8oJeEAAABdUlEQVR4Xu2WPS9EQRSGj49EQ6EV0SgobEKBH4BG4QeIUGwoFRK9QqFTaBVanUiIyh/w1Sg0SpSWECG+3pMzszs53GxudmZnsztP8uRmzzuZ3XPvzN0hSiQSrcwmfII/xjf4CEvwy9Tuy6ObFNu8po+k/qKDZoIbPNRFQ9aNCcGILoRmjqS5UR2AXqpsh5AskXxPUQehuaDsJ2ufersOPLFBMv+sqtcN2+CgcRhum9q+M84nuyQv1P9WW13hJk/hNJwy10VTP3LG+YDne4X9OoiB3e9jOgBdJNmtDnLSBs/hA+xRWVSuKHu/M3ZL1EInyQ28hh0qi0q15qrleeAVcEZyaOpWWRS4sRNdNNiT34BTu4TPcBXuwQUny8MBycGJD1FRWCNpblzVh+C7ySac+rK5cp2f3A3Jv0It7MBPWNBBKLbgB/ymyrJm+TP/EN6f8+XRf/G1DVzWSead0UEjsQKPddEjDd38HZzUxVYhxJJPJBLh+AUiUVk1YrlQiAAAAABJRU5ErkJggg==
[image17]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGkAAAAXCAYAAAAIqmGLAAACnUlEQVR4Xu2YS+hNQRzHfx7FQqEkyiMhykZSLGzEQkgpRcSCjUdEyMrGxoawkawJiaWsvTYWVlIeG69CIXnn9fv2m2Hut3v+53FnznVrPvXtdn/fub8zc2fmnN8ckUwmk8lk/l8OqHZw0PFetVk1XjVWtU71rqNF7wzjQAkrVW9Vv52+ifUTse8u9lU1wv9gULkg/wYE7ey0/+L9UFM6WjQHE/9GdYONivj+MCOl2BtYyibpqOq0ahl5TZklttIvsVET9K1oV7c5SZM4kIKySYrFErF8J9hoAHYhcu1lw9HGJC0Vu8YRNlKQepI2iOU5yEYPHBfLOZwN5aOYN5GNSGwVy7+djZSUTdJD1X3VHdUPsXt+FfaL/X4TGxH4KZZ7ptMcsQIIsdtBu5gcFsu/ho02wIV3cdABb1Tw/ZqLlTFZrN0hNiKB3Cg6los9K6G1YosICyomeB7/Ui1ko00w4N0cLGCuWHusqiosFhvgSTZ6wD+P9rHhgIeyvFeuqr6oprPRDzCoPRx08FkDzwC0f0DxMmaIDfgiGw1A4YE+cN888Krs9jJuql6LnQ/7DgbUrUp6LOaNDmJjXOxWEKvDOLGB4w9oCnbmUJMQa5I8V1SfVdPYaJOiW8dT1SeKrRBrv5HidUHxgWcHdmTRjigC10cF1427Yv7qIPZIrNBA38+pzgZeHU6J5VnARmomiA3qGBvKVNUTiuEQittWTK5zYAjwB6G/XM6j3H7pPLzG8swWWwSIz1edUd0L/Cbg2si3io3YXBarjp6rnrnPV2KvikK2iHXohftMVd6WgT8EffOltxdufYih70UVKoh5+/OsF8u7jY1MfXCG+sDBiMzjwCCB1V9VKTkv6c5rA8+iGkoJDrjdXh9lMplMpr/8AVj6r03VoSGtAAAAAElFTkSuQmCC
[image18]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHMAAAAXCAYAAAA4JnCqAAAC2UlEQVR4Xu2ZS6hNURzG/17lkdfgignJKzGQSygTMRBSJh5JiYmSIldGEhMDCSVJZigGDJRSyoBMKI+8BpgqlHdeef0//7Vuy3f2Os7eZ+97TveuX3111/ftu/Z67H33WuuKJBKJRCKRKMJw1XPVb9Udyjx7VB9Un1WbKSuDfmz8h2WqN2Jthr6p3jnvu/O+qgb4X+gLbBTr+CBX3qt6350aj1VXg/JD1c2g3AyjVa9V1zloED+ZzECJZ72SDrHODg48HoARVPbAG8VmDiaLvTnnOcgJ2vGWTQf3pUrGstHTZHV2KJXvSe01AN4pNhtgodjvHuagAHirUdd2DhxZ/SubRWL32M9BT4NGPHA/LxD7djKxAYn5MdaKXb+LgyY4JFZnfw6UT2LZGA5KYpNY/Vs4aAXTxRpzVnVfNUx1zHkhsUmL+cxOsevWc1ACP8XqnuQ0TdXlvLK+6QwWgqh/JQetZJ1kT8gv1ZegnHUNiPkh48Su2c1BSaBuLJ6WqBY7rVL9UD0KriuD42JjM4eDdmC52GC8IP+a8z2xSYv5WcwXG4gjHDSB/17u4MCBDNuVZrko9nBP4KCdQOPQ4dPkX3L+XFeOTVrMr8dEsYE5x0EBsIDC/WP7yCLty+KG6pVqJAftBjrLW4PLzp/qyh9dmYH3hM0GwZYGA4SBKgre9Kx2ecqaTM8FsQOT8Ry0C+jsM/J4K7Kayh54nWzmBBt7fNvwUMTesBi4P1asWdwWy1cE3lOxBdNS1RnVySDLw1GxemZz0GpmSu1EobwvwwuX4AedVyZX2KgDBhL3520OtiFYAyDbEPhTxB4W+LNUJ1R3g7wIuDfqw9qjbdgm1ih/Nnvg3/gvQ8SyW2LbGJzc5D1LLQMMHM5d/ZbEC39y4b1Ube2+upayH0CwRqzeKs6rExGwB8U/CqpiBhu9EbxNjapKcDhS1X63zzAvh6oEBwlZx36JRCKRSNTjDz2Nx7qDYoHMAAAAAElFTkSuQmCC
[image19]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAAAXCAYAAACoNQllAAABeklEQVR4Xu2WTytEURjGX/JvIbGwUaQsWLLAB2CnfADJjuUsfAYLZeEr2Ei2iqykLKywRJIVhQUmEvn3vL3nzJxeXXeuzuTccX716zbPc2uad+455xJFIpFIOCzAB/hpfIZ38B6+m+yqdPc/xg5I00WSP+oiA63wCa7qIk/wEDZ0aEgaXlba4DXch3WqC5pJkgEM6gJ0UHnp+aIBHsML2KK6IDmg5CfEPj31uvDELsl+16nyoLBD6DMOwGWTrTv3VZM1+ELy/cHBg9iB43DMXGdMvuncV2324K0O/xq7/wzpAjSTdOe68EgjPIVnsEl1QXBEyfsP4+sE07TDG5KnJmjSBpDWZ6WX5ETkPScX8I/f1qHBvmH3ONkhLMICXIHTTvcT/ArxAZd0ETLzJAMYVnk/yYnC3YiTz5or5/x2fEJy2qXRTTLQ3LAIX0n+UbuEWP78RrIpT5Xu/o7PJVdzzMEtHUbKXMJRHVbARAZzzW+XFw+1UiORSO3yBQYVXrL3LPeZAAAAAElFTkSuQmCC
[image20]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADsAAAAaCAYAAAAJ1SQgAAACl0lEQVR4Xu2Xu2tUQRTGj08UiZLGVEYI2EoKxVchKmjA1iKEYFQI2GgjilrYCcFKwUILi2gpiuA/oIIYCAENgiaChYgYXyiJb1HPtzPjnv12du7uXvYqsj/42DvfOXP27sydubMibf45xlW/VHc58LfZyUZO3pjry6rvpg36qd00q1UXVOdVyykW46DqOJs5wYyO+Ot5vm3pUT0gryHOiiu617e7Va9UX/5kVLNK9YJNA2YINYOYp1IZn6oMl1gv8b7nVBfZzGK+uGK3OeD5ofrJpgf9lrBJ3FBNiMvdRDGwUPWITQMe4QE2PbFBSIIOGOFabBeXs4P8zaqv5MVA38X+8xvFwCHVbjY9lyS9Pq9IA4/zc8kenTDzV8nHiNezVj/4T/xQ1MFMWl5SO3BAtdFfb7EBwwrJvv8SW8Ul3iKf6RSX9558eEvJY9aqjvhr3DD63CmHS8Rudp24DWqfaljiazmA/pkbKWYGiVlrblBc3n3jdXgvi+uqBaaNPtzvHrVByLOqBWIn2GSyigSmxeXhFRPY5r0sOAezBS/MNmrmfUej3iiblpVS/4+N5e2PeDHCerXYejM20CSfVWNsWvBo4QuRmGKPuDx+LQ15P0Wv6iibykNxfdf4z7x8FPdqSxKbMaZWDnbJmG+5KdU7L1gmri9mnTerZkAt7A1J8GWpG34mLr6IA1LeoVOk4jikII61nxfUOclmDCROsqm8lurDN4O+OCzEOCwujnNtjD5JD0YjoA4Gvy7C+RWLHGsY1xsqMuIgL+yqATy2s6p3Xp9UuyoyyrxlownCkmg5x1RzbBYM/p1dY7NVYFRjm1BRFDKrAay9J2wWxCnVaTZbzRlx59ci6VI9ZrMohthoMdjt27Rp8x/yG7wVqXmjnjTHAAAAAElFTkSuQmCC
[image21]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAbCAYAAACjkdXHAAAAwElEQVR4XmNgGPaAC12AWHAbiD+jCxIDpIH4PxSTDGAaSdacAcT5DGRqhmkgWfN+IJaFsl8xkKAZFC13kPiHGSCaGZHEcILvaPx5DBDNWmjiGMANiL8C8XkgPgXEp4H4BQNEcziSOqzgBhB/QsPfGCCa85DUYQApID6BLggEegwQzXPQJZABrhBlY4DIgbyAATiA+DkDxHnYgAgDRPNvdIlpQPwBiN8yQDR/QZVm+MuAkAf5/w8Qm6OoGAWjABcAAFndNJYyVs7BAAAAAElFTkSuQmCC
[image22]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAZCAYAAADXPsWXAAAAxklEQVR4XmNgGAWEQAsQfwTi/1D8HYjfA/EHIP4LFXsGV00AwAxBB1IMEPEv6BLYAEjhJnRBKMBlAQrwY4AoMkCXAAJBBoQ38YKzDLhtgrmCCV0CHcAUKkOxBhD3Q8VWIqnDC0CK9wGxCxA7Q+k4qPhWJHU4ASw8DNElgICdASJ3F10CHZxnwB0eIEBUzIAUfEYXhIIUBoj8UXQJZABLSOXoEkBgxACR+40uAQOgwDvJgHDqDSA+CMR7oTRMfAJMwygYBQMGAM+MOSX549GiAAAAAElFTkSuQmCC
[image23]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAaCAYAAAC+aNwHAAAAuElEQVR4XmNgGPZAGogLgHgmECshiVshsbGCxUD8H4hvA7E3EKsC8TQgfg7EllA5nAAk+Q+I+dElgKCSASJ/CV0CBv4wEDCdASIfhC4IAh8YIJKc6BJoAKsFugwQiVvoElgAVgP+MkAksPmbKADSjNVkYgFFBjAzQDS/RJfAAnBaQowLLIA4AV0QBu4yQAwAuQYbAIm/QhdEByADQAkJ3RAjIH6NJoYT7GZAeOcrlE5FUTEKRgEtAAA6VitB6iN1UwAAAABJRU5ErkJggg==
