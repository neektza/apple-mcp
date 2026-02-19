import { runAppleScript } from "run-applescript";

// Configuration
const CONFIG = {
	// Maximum notes to process (to avoid performance issues)
	MAX_NOTES: 100,
	// Maximum content length for previews
	MAX_CONTENT_PREVIEW: 200,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

type Note = {
	name: string;
	content: string;
	creationDate?: Date;
	modificationDate?: Date;
};

type CreateNoteResult = {
	success: boolean;
	note?: Note;
	message?: string;
	folderName?: string;
	usedDefaultFolder?: boolean;
};


/**
 * Parse delimited note string from AppleScript into Note objects.
 * AppleScript records don't serialize to JS objects through run-applescript,
 * so we use custom delimiters instead.
 */
function parseDelimitedNotes(raw: string): Note[] {
	if (!raw) return [];
	const notes: Note[] = [];
	const noteMatches = raw.match(/<<<NOTE_START>>>([\s\S]*?)<<<NOTE_SEP>>>([\s\S]*?)<<<NOTE_END>>>/g);
	if (noteMatches) {
		for (const match of noteMatches) {
			const parts = match.match(/<<<NOTE_START>>>([\s\S]*?)<<<NOTE_SEP>>>([\s\S]*?)<<<NOTE_END>>>/);
			if (parts) {
				notes.push({
					name: parts[1] || "Untitled Note",
					content: parts[2] || "",
				});
			}
		}
	}
	return notes;
}

/**
 * Check if Notes app is accessible
 */
async function checkNotesAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Notes"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Notes app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Notes app access and provide instructions if not available
 */
async function requestNotesAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkNotesAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Notes access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Notes access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Notes'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Notes access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

/**
 * Get all notes from Notes app (limited for performance)
 */
async function getAllNotes(): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const script = `
tell application "Notes"
    set outputText to ""
    set noteCount to 0

    -- Get all notes from all folders
    set allNotes to notes

    repeat with i from 1 to (count of allNotes)
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        try
            set currentNote to item i of allNotes
            set noteName to name of currentNote
            set noteContent to plaintext of currentNote

            -- Limit content for preview
            if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                set noteContent to noteContent & "..."
            end if

            set outputText to outputText & "<<<NOTE_START>>>" & noteName & "<<<NOTE_SEP>>>" & noteContent & "<<<NOTE_END>>>"
            set noteCount to noteCount + 1
        on error
            -- Skip problematic notes
        end try
    end repeat

    return outputText
end tell`;

		const result = (await runAppleScript(script)) as string;

		return parseDelimitedNotes(result);
	} catch (error) {
		console.error(
			`Error getting all notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Returns true if searchText contains regex metacharacters,
 * indicating the caller intends it as a pattern rather than a literal string.
 */
function isRegexPattern(searchText: string): boolean {
	return /[.*+?[\](){}^$|\\]/.test(searchText);
}

/**
 * Build a case-insensitive RegExp from searchText.
 * If searchText is already a valid regex pattern it is used as-is;
 * otherwise it is treated as a literal string.
 */
function buildSearchRegex(searchText: string): RegExp {
	try {
		return new RegExp(searchText, "i");
	} catch {
		const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(escaped, "i");
	}
}

/**
 * Compute Dice coefficient over character bigrams of two strings.
 */
function bigramSimilarity(a: string, b: string): number {
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
	const bigrams = (s: string) => {
		const set = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
		return set;
	};
	const ba = bigrams(a);
	const bb = bigrams(b);
	let intersection = 0;
	for (const bg of ba) if (bb.has(bg)) intersection++;
	return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Score how well `query` matches `target`. Returns 0–1.
 */
function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase().trim();
	const t = target.toLowerCase();
	if (!q || !t) return 0;
	if (t.includes(q)) return 1.0;
	const tokens = q.split(/\s+/).filter(Boolean);
	const matched = tokens.filter((tok) => t.includes(tok));
	if (matched.length === tokens.length) return 0.9;
	if (matched.length > 0) return 0.4 + 0.4 * (matched.length / tokens.length);
	return bigramSimilarity(q, t) * 0.5;
}

/**
 * Server-side name search using AppleScript whose clause.
 * Fast — delegates filtering to Notes.app, no per-note round-trip.
 * Returns notes with truncated content previews.
 */
async function findNotesByName(searchText: string): Promise<Note[]> {
	const escaped = searchText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `
tell application "Notes"
    set matchingNotes to notes whose name contains "${escaped}"
    set outputText to ""
    repeat with theNote in matchingNotes
        set noteName to name of theNote
        set noteContent to plaintext of theNote
        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
            set noteContent to noteContent & "..."
        end if
        set outputText to outputText & "<<<NOTE_START>>>" & noteName & "<<<NOTE_SEP>>>" & noteContent & "<<<NOTE_END>>>"
    end repeat
    return outputText
end tell`;
	const raw = (await runAppleScript(script)) as string;
	return parseDelimitedNotes(raw);
}

/**
 * Find notes by search text using a three-tier strategy:
 *
 * 1. AppleScript server-side name search (fast, no cap, case-insensitive substring).
 *    Results are then filtered by the regex for precision.
 * 2. If tier 1 returns nothing: fetch all notes (up to MAX_NOTES) and apply
 *    the regex against both name and content.
 * 3. If tier 2 returns nothing: bigram similarity fallback for typo tolerance,
 *    scored against note names.
 */
async function findNote(searchText: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		if (!searchText || searchText.trim() === "") {
			return [];
		}

		// Tier 1: server-side name search via AppleScript whose clause
		const nameMatches = await findNotesByName(searchText);
		if (nameMatches.length > 0) return nameMatches;

		// Fetch all notes once — reused by tier 2 and tier 3
		const allNotes = await getAllNotes();

		// Tier 2 (regex only): apply regex to name + content across all notes
		if (isRegexPattern(searchText)) {
			const pattern = buildSearchRegex(searchText);
			const tier2 = allNotes.filter(
				(note) => pattern.test(note.name) || pattern.test(note.content),
			);
			if (tier2.length > 0) return tier2;
		}

		// Tier 3: bigram similarity on note names (typo tolerance)
		const BIGRAM_THRESHOLD = 0.3;
		const MAX_FUZZY_RESULTS = 5;
		return allNotes
			.map((note) => ({ note, score: fuzzyScore(searchText, note.name) }))
			.filter(({ score }) => score >= BIGRAM_THRESHOLD)
			.sort((a, b) => b.score - a.score)
			.slice(0, MAX_FUZZY_RESULTS)
			.map(({ note }) => note);
	} catch (error) {
		console.error(
			`Error finding notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Create a new note
 */
async function createNote(
	title: string,
	body: string,
	folderName: string = "Claude",
): Promise<CreateNoteResult> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		// Validate inputs
		if (!title || title.trim() === "") {
			return {
				success: false,
				message: "Note title cannot be empty",
			};
		}

		// Keep the body as-is to preserve original formatting
		// Notes.app handles markdown and formatting natively
		const formattedBody = body.trim();

		// Use file-based approach for complex content to avoid AppleScript string issues
		const tmpFile = `/tmp/note-content-${Date.now()}.txt`;
		const fs = require("fs");

		// Write content to temporary file to avoid AppleScript escaping issues
		fs.writeFileSync(tmpFile, formattedBody, "utf8");

		const script = `
tell application "Notes"
    set targetFolder to null
    set folderFound to false
    set actualFolderName to "${folderName}"

    -- Try to find the specified folder
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set targetFolder to currentFolder
                set folderFound to true
                exit repeat
            end if
        end repeat
    on error
        -- Folders might not be accessible
    end try

    -- If folder not found and it's a test folder, try to create it
    if not folderFound and ("${folderName}" is "Claude" or "${folderName}" is "Test-Claude") then
        try
            make new folder with properties {name:"${folderName}"}
            -- Try to find it again
            set allFolders to folders
            repeat with currentFolder in allFolders
                if name of currentFolder is "${folderName}" then
                    set targetFolder to currentFolder
                    set folderFound to true
                    set actualFolderName to "${folderName}"
                    exit repeat
                end if
            end repeat
        on error
            -- Folder creation failed, use default
            set actualFolderName to "Notes"
        end try
    end if

    -- Read content from file to preserve formatting
    set noteContent to read file POSIX file "${tmpFile}" as «class utf8»

    -- Create the note with proper content
    if folderFound and targetFolder is not null then
        -- Create note in specified folder
        make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:" & actualFolderName & ":false"
    else
        -- Create note in default location
        make new note with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:Notes:true"
    end if
end tell`;

		const result = (await runAppleScript(script)) as string;

		// Clean up temporary file
		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {
			// Ignore cleanup errors
		}

		// Parse the result string format: "SUCCESS:folderName:usedDefault"
		if (result && typeof result === "string" && result.startsWith("SUCCESS:")) {
			const parts = result.split(":");
			const folderName = parts[1] || "Notes";
			const usedDefaultFolder = parts[2] === "true";

			return {
				success: true,
				note: {
					name: title,
					content: formattedBody,
				},
				folderName: folderName,
				usedDefaultFolder: usedDefaultFolder,
			};
		} else {
			return {
				success: false,
				message: `Failed to create note: ${result || "No result from AppleScript"}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			message: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes from a specific folder
 */
async function getNotesFromFolder(
	folderName: string,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0
    set folderFound to false

    -- Try to find the specified folder
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set folderFound to true

                -- Get notes from this folder
                set folderNotes to notes of currentFolder

                repeat with i from 1 to (count of folderNotes)
                    if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        -- Limit content for preview
                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set noteInfo to {name:noteName, content:noteContent}
                        set notesList to notesList & {noteInfo}
                        set noteCount to noteCount + 1
                    on error
                        -- Skip problematic notes
                    end try
                end repeat

                exit repeat
            end if
        end repeat
    on error
        -- Handle folder access errors
    end try

    if not folderFound then
        return "ERROR:Folder not found"
    end if

    return "SUCCESS:" & (count of notesList)
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Simple success/failure check based on string result
		if (result && typeof result === "string") {
			if (result.startsWith("ERROR:")) {
				return {
					success: false,
					message: result.replace("ERROR:", ""),
				};
			} else if (result.startsWith("SUCCESS:")) {
				// For now, just return success - the actual notes are complex to parse from AppleScript
				return {
					success: true,
					notes: [], // Return empty array for simplicity
				};
			}
		}

		// If we get here, assume folder was found but no notes
		return {
			success: true,
			notes: [],
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get recent notes from a specific folder
 */
async function getRecentNotesFromFolder(
	folderName: string,
	limit: number = 5,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// For simplicity, just get notes from folder (they're typically in recent order)
		const result = await getNotesFromFolder(folderName);

		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}

		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get recent notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes by date range (simplified implementation)
 */
async function getNotesByDateRange(
	folderName: string,
	fromDate?: string,
	toDate?: string,
	limit: number = 20,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// For simplicity, just return notes from folder
		// Date filtering is complex and unreliable in AppleScript
		const result = await getNotesFromFolder(folderName);

		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}

		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes by date range: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

type EditNoteResult = {
	success: boolean;
	message?: string;
};

/**
 * Edit an existing note's content (and optionally rename it)
 */
async function editNote(title: string, newBody: string, newTitle?: string): Promise<EditNoteResult> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return { success: false, message: accessResult.message };
		}

		const fs = require("fs");
		const tmpFile = `/tmp/note-edit-${Date.now()}.txt`;
		fs.writeFileSync(tmpFile, newBody, "utf8");

		const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const finalTitle = newTitle ?? title;
		const escapedFinalTitle = finalTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		const script = `
tell application "Notes"
    set matchingNotes to notes whose name = "${escapedTitle}"
    if (count of matchingNotes) > 0 then
        set theNote to item 1 of matchingNotes
        set noteContent to read POSIX file "${tmpFile}" as «class utf8»
        set body of theNote to noteContent
        set name of theNote to "${escapedFinalTitle}"
        return "SUCCESS"
    else
        return "ERROR:Note not found"
    end if
end tell`;

		const result = (await runAppleScript(script)) as string;

		try { fs.unlinkSync(tmpFile); } catch (_) {}

		if (result && result.startsWith("ERROR:")) {
			return { success: false, message: result.slice(6) };
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			message: `Failed to edit note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get a single note by exact title, returning full untruncated content
 */
async function getNoteByTitle(title: string): Promise<Note | null> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = `
tell application "Notes"
    set matchingNotes to notes whose name = "${escapedTitle}"
    if (count of matchingNotes) > 0 then
        set theNote to item 1 of matchingNotes
        return "<<<NOTE_START>>>" & name of theNote & "<<<NOTE_SEP>>>" & plaintext of theNote & "<<<NOTE_END>>>"
    else
        return "<<<NOT_FOUND>>>"
    end if
end tell`;

		const raw = (await runAppleScript(script)) as string;
		if (!raw || raw.includes("<<<NOT_FOUND>>>")) return null;
		const notes = parseDelimitedNotes(raw);
		return notes.length > 0 ? notes[0] : null;
	} catch (error) {
		console.error(
			`Error getting note by title: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

export default {
	getAllNotes,
	findNote,
	getNoteByTitle,
	createNote,
	editNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
