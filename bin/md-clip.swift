#!/usr/bin/env swift
// md-clip: pipe markdown into this tool and it copies to clipboard as
// plain text (markdown), HTML, and RTF — covering web apps (Slack, Notion,
// Google Docs) and native macOS apps (Mail, Pages) respectively.
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

// MARK: - Run pandoc

func runPandoc(to format: String, extraArgs: [String] = []) -> Data {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    proc.arguments = ["pandoc", "-f", "gfm", "-t", format] + extraArgs

    let inPipe  = Pipe()
    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardInput  = inPipe
    proc.standardOutput = outPipe
    proc.standardError  = errPipe

    do { try proc.run() } catch {
        fputs("md-clip: error: could not launch pandoc — \(error.localizedDescription)\n", stderr)
        exit(1)
    }

    inPipe.fileHandleForWriting.write(inputData)
    inPipe.fileHandleForWriting.closeFile()
    proc.waitUntilExit()

    if proc.terminationStatus != 0 {
        let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        fputs("md-clip: error: pandoc (\(format)) failed:\n\(msg)\n", stderr)
        exit(1)
    }

    let out = outPipe.fileHandleForReading.readDataToEndOfFile()
    if out.isEmpty {
        fputs("md-clip: error: pandoc (\(format)) produced no output\n", stderr)
        exit(1)
    }
    return out
}

let rtfData  = runPandoc(to: "rtf",  extraArgs: ["--standalone", "--wrap=none"])
let htmlData = runPandoc(to: "html", extraArgs: ["--wrap=none"])

// MARK: - Write to clipboard

let pasteboard = NSPasteboard.general
pasteboard.clearContents()

let item = NSPasteboardItem()
item.setString(markdownText, forType: .string)           // plain text: raw markdown
item.setData(htmlData, forType: .html)                   // HTML: for Slack, Notion, browsers
item.setData(rtfData,  forType: .rtf)                    // RTF:  for Mail, Pages, TextEdit

guard pasteboard.writeObjects([item]) else {
    fputs("md-clip: error: failed to write to pasteboard\n", stderr)
    exit(1)
}

let lineCount = markdownText.components(separatedBy: "\n").count
fputs("md-clip: copied \(inputData.count) bytes (\(lineCount) lines) — plain text + HTML + RTF\n", stderr)
