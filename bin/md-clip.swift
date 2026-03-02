#!/usr/bin/env swift
// md-clip: pipe markdown into this tool and it copies to clipboard as both
// plain text (markdown) and rich text (RTF via pandoc).
//
// Build: swiftc -framework AppKit md-clip.swift -o md-clip
// Usage: echo "**hello**" | md-clip

import Foundation
import AppKit

// MARK: - Read stdin

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard !inputData.isEmpty, let markdownText = String(data: inputData, encoding: .utf8) else {
    fputs("md-clip: error: no input or non-UTF-8 data on stdin\n", stderr)
    exit(1)
}

// MARK: - Preprocess: normalise Slack-style bullets to markdown list items

/// Converts Unicode bullet characters (• U+2022) at the start of lines into
/// standard markdown `- ` list items and ensures a blank line precedes the
/// first item of each group so pandoc recognises the block as a list.
func preprocessMarkdown(_ text: String) -> String {
    let bullet = "\u{2022}"
    let lines  = text.components(separatedBy: "\n")
    var out: [String] = []
    out.reserveCapacity(lines.count)

    for (i, line) in lines.enumerated() {
        let stripped = line.trimmingCharacters(in: .whitespaces)
        let isBullet = stripped.hasPrefix(bullet)

        if isBullet {
            // Guarantee a blank separator before the first bullet in a run
            let prevStripped = i > 0 ? lines[i - 1].trimmingCharacters(in: .whitespaces) : ""
            if !prevStripped.isEmpty && !prevStripped.hasPrefix(bullet) {
                out.append("")
            }
            // Replace the leading bullet (and one optional space) with "- "
            let body = stripped
                .dropFirst()                          // drop •
                .drop(while: { $0 == " " })           // drop leading spaces
            out.append("- \(body)")
        } else {
            out.append(line)
        }
    }

    return out.joined(separator: "\n")
}

let processedText = preprocessMarkdown(markdownText)
let processedData = Data(processedText.utf8)

// MARK: - Convert via pandoc (markdown → RTF)

let pandoc = Process()
pandoc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
pandoc.arguments = ["pandoc", "-f", "markdown", "-t", "rtf", "--standalone"]

let inPipe  = Pipe()
let outPipe = Pipe()
let errPipe = Pipe()
pandoc.standardInput  = inPipe
pandoc.standardOutput = outPipe
pandoc.standardError  = errPipe

do {
    try pandoc.run()
} catch {
    fputs("md-clip: error: could not launch pandoc — \(error.localizedDescription)\n", stderr)
    exit(1)
}

inPipe.fileHandleForWriting.write(processedData)
inPipe.fileHandleForWriting.closeFile()
pandoc.waitUntilExit()

guard pandoc.terminationStatus == 0 else {
    let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    fputs("md-clip: error: pandoc failed:\n\(msg)\n", stderr)
    exit(1)
}

let rtfData = outPipe.fileHandleForReading.readDataToEndOfFile()
guard !rtfData.isEmpty else {
    fputs("md-clip: error: pandoc produced no output\n", stderr)
    exit(1)
}

// MARK: - Write to clipboard with both representations

let pasteboard = NSPasteboard.general
pasteboard.clearContents()

let item = NSPasteboardItem()
// Plain text: the original markdown source
item.setString(markdownText, forType: .string)
// Rich text: RTF from pandoc
item.setData(rtfData, forType: .rtf)

guard pasteboard.writeObjects([item]) else {
    fputs("md-clip: error: failed to write to pasteboard\n", stderr)
    exit(1)
}

let lineCount = markdownText.components(separatedBy: "\n").count
fputs("md-clip: copied \(inputData.count) bytes (\(lineCount) lines) — plain text + RTF\n", stderr)
