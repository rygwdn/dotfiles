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

inPipe.fileHandleForWriting.write(inputData)
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
