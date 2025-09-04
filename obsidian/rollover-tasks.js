// Rollover Tasks - Dataview script for managing task rollovers
// This script accepts a query result and displays rollover tasks with interactive controls
//
// Example usage:
// ```dataviewjs
// const query = `
// 	TASK
// 	WHERE !checked AND !contains(tags, "#nighthack")
// 	FLATTEN firstvalue([due, scheduled, file.day]) as taskDate
// 	WHERE taskDate AND taskDate <= date(today)
// 	SORT taskDate ASC
// `;
// await dv.view("scripts/dataview/rollover-tasks", {query, obsidian});
// ```

// Get the query result and Obsidian API passed from the calling script
const { query, obsidian } = input;

if (!obsidian || !query) {
    dv.paragraph("*Obsidian API or query is not available*");
    return;
}

if (!dv.component.isCustom) {
    addStyles();

    console.log("Setting up custom renderer");
    dv.component.isCustom = true;
    dv.component.render = async function() {
        await render();
    };
}

async function render() {
    if (!dv.current().file.day) {
        dv.container.innerHTML = "";
        dv.paragraph("*Not a daily log file*");
        return;
    }

    const queryResult = await dv.tryQuery(query);

    // Filter results to only include top-level tasks (not subtasks)
    // and tasks with status other than ">" or "x"
    const tasks = queryResult.values.filter(task => {
        const isSubtask = task.parent && task.parent !== task.line;
        const hasValidStatus = task.status !== "x" && task.status !== "X" && task.status !== ">";
        const isCurrentFile = task.path === dv.currentFilePath;
        return !isSubtask && hasValidStatus && !isCurrentFile;
    });

    console.log('rendering', {tasks, queryResult});

    if (tasks.length === 0) {
        dv.container.innerHTML = "";
        dv.paragraph("*No tasks to roll over*");
        return;
    }

    const container = dv.container.querySelector(".rollover-container") || dv.container.createEl("div", { cls: "rollover-container" });

    const existingTaskRows = {};
    for (const row of dv.container.querySelectorAll(".rollover-task-row")) {
        const rowId = row.getAttribute("data-task-id");
        if (rowId) {
            if (!tasks.some(t => taskId(t) === rowId)) {
                row.remove();
            } else {
                existingTaskRows[rowId] = row;
            }
        }
    }

    // Ensure rows are rendered in the same order as the tasks array
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskRow = renderTaskRow(container, task, existingTaskRows[taskId(task)]);

        // Ensure the task row is at child position i
        if (taskRow && container.children[i] !== taskRow) {
            if (i >= container.children.length) {
                container.appendChild(taskRow);
            } else {
                container.insertBefore(taskRow, container.children[i]);
            }
        }
    }
}

function taskId(task) {
    return `${task.path}:${task.line}`;
}

function renderTaskRow(container, task, existingTaskRow) {
    const taskRow = existingTaskRow || container.createEl("div", { cls: "rollover-task-row" });
    taskRow.innerHTML = "";
    taskRow.setAttribute("data-task-id", taskId(task));

    const rolloverBtn = createRolloverButton(taskRow, task, taskRow);
    createCheckbox(taskRow, task, taskRow, rolloverBtn);

    createFileLink(taskRow, task);

    dv.el("span", task.text, { container: taskRow, cls: "task-text" });

    if (!task.due && task.file?.day) {
        const date = task.file.day.toFormat('yyyy-MM-dd');
        dv.el("span", ` 📅 ${date}`, { container: taskRow, cls: "task-date", attr: { title: date } });
    }

    return taskRow;
}

function addStyles() {
    // Add CSS styles for the rollover tasks
    const sty = dv.container.createEl("style");
    sty.innerHTML = `
        .rollover-container {
            display: flex;
            flex-direction: column;
            gap: 0px;
        }

        .rollover-task-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 2px 4px;
            border-radius: 4px;
            padding-top: 1.2px;
            padding-bottom: 1.2px;
            margin-top: 3px;
            margin-bottom: 3px;
            transition: background-color 0.15s ease;
        }

        .rollover-task-row:hover {
            background-color: var(--background-modifier-hover);
        }

        .rollover-task-row.completed {
            opacity: 0.5;
            text-decoration: line-through;
        }

        .rollover-task-row.rolled-over {
            opacity: 0.3;
            text-decoration: line-through;
        }

        .rollover-btn {
            width: 20px;
            height: 20px;
            padding: 0;
            cursor: pointer;
            background: transparent;
            border: 1px solid var(--text-muted);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.15s ease;
        }

        .rollover-btn:hover:not(:disabled) {
            border-color: var(--text-accent);
            background: var(--background-modifier-hover);
        }

        .rollover-btn:disabled {
            cursor: not-allowed;
            opacity: 0.3;
        }

        .task-checkbox {
            cursor: pointer;
        }

        .task-checkbox:disabled {
            cursor: not-allowed;
        }

        .task-text {
            cursor: default;
        }

        .subtask-info {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            color: var(--text-muted);
            font-size: 0.85em;
            cursor: pointer;
        }

        .subtask-icon {
            display: inline-flex;
            width: 14px;
            height: 14px;
        }

        .file-link {
            display: inline-flex;
            text-decoration: none;
            cursor: pointer;
        }

        .task-date {
            color: var(--text-muted);
            font-size: 0.85em;
        }
    `;
}

// Helper function to handle task completion
async function completeTask(task) {
    try {
        const tasksApi = app.plugins.getPlugin('obsidian-tasks-plugin').apiV1;

        // Get the current task line
        const fileContent = await app.vault.read(app.vault.getAbstractFileByPath(task.path));
        const lines = fileContent.split('\n');
        const taskLine = lines[task.line];

        // Use Tasks API to toggle completion (handles recurring tasks automatically)
        const updatedTaskLine = await tasksApi.executeToggleTaskDoneCommand(taskLine, task.path);

        if (!updatedTaskLine || updatedTaskLine === taskLine) {
            throw new Error("Tasks API did not return an updated task");
        }

        lines[task.line] = updatedTaskLine;
        await app.vault.modify(app.vault.getAbstractFileByPath(task.path), lines.join('\n'));

        return { success: true };

    } catch (error) {
        console.error("Error completing task:", error);
        new Notice(`❌ ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function markTaskAsMovedAndExtractContent(task) {
    const originalFile = app.vault.getAbstractFileByPath(task.path);
    const fileContent = await app.vault.read(originalFile);
    const lines = fileContent.split('\n');

    const taskLineNum = task.line;
    const taskLine = lines[taskLineNum];

    // Extract existing block reference or generate a new one
    const existingBlockRefMatch = taskLine.match(/\^([a-zA-Z0-9]+)\s*$/);
    const blockRef = existingBlockRefMatch ? existingBlockRefMatch[1] : Math.random().toString(36).substring(2, 8);

    // Get current file name for reference
    const currentFilePath = dv.currentFilePath;
    const currentFileName = currentFilePath ? currentFilePath.split('/').pop().replace('.md', '') : 'current file';

    // Update the original task line to show it was moved
    // Check if the task already has a forward link (already been rolled over)
    const hasForwardLink = /\[\[[^\]]+\|moved\]\]/.test(taskLine);
    let updatedLine;

    if (hasForwardLink) {
        // Update existing "moved" link to point to new file and update status to [>]
        updatedLine = taskLine
            .replace(/^(\s*)-\s*\[[^\]]*\]/, `$1- [>]`)
            .replace(/\[\[[^\]]+\|moved\]\]/, `[[${currentFileName}|moved]]`);

        // Add block reference if it doesn't already exist
        if (!existingBlockRefMatch) {
            updatedLine = updatedLine + ` ^${blockRef}`;
        }
    } else {
        // Add the forward link if it doesn't have one
        updatedLine = taskLine.replace(/^(\s*)-\s*\[[^\]]*\](.*)$/, `$1- [>]$2 [[${currentFileName}|moved]] ^${blockRef}`);
    }

    lines[taskLineNum] = updatedLine;
    if (updatedLine === taskLine) {
        throw new Error("Task line did not change");
    }

    // Get the task and its children (indented content)
    const originalFileName = originalFile.basename;

    // Clean the original task line by removing blockrefs, "moved" links, and "✈︎" links
    const cleanTaskLine = taskLine
        .replace(/\s*\^[a-zA-Z0-9]+\s*$/, '') // Remove block references at end of line
        .replace(/\s*\[\[[^\]]+\|moved\]\]/g, '') // Remove "moved" links
        .replace(/\s*\(\[\[[^\]]+#\^[^|]+\|✈︎\]\]\)/g, '') // Remove "✈︎" backlinks
        .trim();

    // Check if the cleaned task already has a backlink (already been rolled over)
    const hasBacklink = /\(\[\[[^\]]+#\^[^|]+\|✈︎\]\]\)/.test(cleanTaskLine);
    let newTask;

    if (hasBacklink) {
        // Just reset the status to [ ] if it already has a backlink
        newTask = cleanTaskLine.replace(/^(\s*)-\s*\[[^\]]*\]/, `$1- [ ]`);
    } else {
        // Add the backlink if it doesn't have one
        newTask = cleanTaskLine.replace(/^(\s*)-\s*\[[^\]]*\](.*)$/, `$1- [ ]$2 ([[${originalFileName}#^${blockRef}|✈︎]])`);
    }

    const taskContent = [newTask];
    const baseIndent = taskLine.match(/^\s*/)[0].length;

    // Collect all child content (subtasks and notes) and update subtask statuses
    for (let i = taskLineNum + 1; i < lines.length; i++) {
        const currentIndent = lines[i].match(/^\s*/)[0].length;
        if (currentIndent <= baseIndent) {
            break;
        }

        taskContent.push(lines[i]);

        // Also mark subtasks as moved in the original file
        if (/^\s*-\s*\[[^\]]*\]/.test(lines[i])) {
            lines[i] = lines[i].replace(/^(\s*-\s*)\[[^\]]*\]/, '$1[>]');
        }
    }

    const markCompleted = async () => {
        await app.vault.modify(originalFile, lines.join('\n'));
    }

    return {
        markCompleted,
        taskContent,
    }
}

// Helper function to copy task content to current file
async function copyTaskToCurrentFile(taskContent) {
    const currentFilePath = dv.currentFilePath;
    const currentFile = app.vault.getAbstractFileByPath(currentFilePath);

    const currentContent = await app.vault.read(currentFile);
    const dailyLogMatch = currentContent.match(/## Daily Log\n([\s\S]*?)(?=\n##|$)/);
    if (!dailyLogMatch) {
        throw new Error("No Daily Log section found");
    }

    const initialIndent = taskContent[0].match(/^\s*/)[0].length;
    const newContentLines = taskContent.map(line => line.slice(initialIndent)).join('\n').replace(/^\n/, '');

    const insertPosition = dailyLogMatch.index + dailyLogMatch[0].length;
    const contentBefore = currentContent.slice(0, insertPosition).replace(/\n$/, '');
    const contentAfter = currentContent.slice(insertPosition);

    await app.vault.modify(currentFile, `${contentBefore}\n${newContentLines}\n${contentAfter}`);
}

// Helper function to rollover a task
async function rolloverTask(task) {
    const { taskContent, markCompleted } = await markTaskAsMovedAndExtractContent(task);
    await copyTaskToCurrentFile(taskContent);
    await markCompleted();
}

// Helper function to setup hover preview
function setupHoverPreview(element, parent, task) {
    element.addEventListener('mouseenter', (e) => {
        app.workspace.trigger("link-hover", dv.component, parent, /*linktext*/ task.path, /*sourcePath*/ dv.currentFilePath, /*state*/ { scroll: task.line });
    });
}

// Create rollover button
function createRolloverButton(container, task, taskRow) {
    const btn = dv.el("button", "↻", {
        container,
        cls: "rollover-btn",
        attr: { title: "Roll over this task" }
    });

    btn.onclick = async (e) => {
        e.stopPropagation();
        try {
            btn.disabled = true;
            taskRow.querySelector('.task-checkbox').disabled = true;
            taskRow.classList.add("rolled-over");

            await rolloverTask(task);

            const file = app.vault.getAbstractFileByPath(task.path);
            const fileName = file ? file.basename : task.path.split('/').pop().replace('.md', '');
            new Notice(`Task rolled over from ${fileName}`);

            taskRow.remove();
        } catch (error) {
            taskRow.classList.remove("rolled-over");
            console.error("Error rolling over task:", error);
            new Notice("Failed to rollover task: " + error.message);
        }
    };

    return btn;
}

// Create task checkbox
function createCheckbox(container, task, taskRow, rolloverBtn) {
    const checkbox = dv.el("input", "", {
        container,
        cls: "task-checkbox",
        attr: { type: "checkbox", title: "Mark as complete" }
    });

    checkbox.onclick = async (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
            checkbox.disabled = true;
            rolloverBtn.disabled = true;

            const result = await completeTask(task);
            if (result.success) {
                taskRow.remove();
            } else {
                checkbox.checked = false;
            }
        }
    };

    return checkbox;
}

// Create subtask indicator
function createSubtaskIndicator(container, task, subtaskCount) {
    const subtaskContainer = dv.el("span", "", {
        container,
        cls: "subtask-info",
        attr: { title: `${subtaskCount} subtask${subtaskCount > 1 ? 's' : ''}` }
    });

    const iconSpan = dv.el("span", "", {
        container: subtaskContainer,
        cls: "subtask-icon"
    });

    obsidian.setIcon(iconSpan, "list-tree");

    dv.el("span", subtaskCount.toString(), {
        container: subtaskContainer
    });

    return subtaskContainer;
}

// Create file link
function createFileLink(container, task) {
    const file = app.vault.getAbstractFileByPath(task.path);
    const fileName = file ? file.basename : task.path.split('/').pop().replace('.md', '');

    const fileLink = dv.el("a", "📄", {
        container,
        cls: "file-link",
        attr: {
            href: "#",
            title: fileName,
            "data-href": task.path
        }
    });

    if (task.subtasks.length > 0) {
        createSubtaskIndicator(fileLink, task, task.subtasks.length);
    }

    setupHoverPreview(fileLink, container, task);

    fileLink.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        app.workspace.openLinkText(task.path, task.path, false, {
            eState: { line: task.line }
        });
    };

    return fileLink;
}

render();
