#!/usr/bin/env python
# encoding: utf-8

import sys
import subprocess


topic = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
base = sys.argv[2] if len(sys.argv) > 2 else None

if not base:
    branches = subprocess.check_output("git for-each-ref --format='%(refname)' {refs}".format(
            refs=" ".join("refs/remotes/origin/" + b for b in ["topic/project-zero", "develop", "master", "client/"])
        ), shell=True).splitlines()
    commits = None
    for maybe_base in branches:
        maybe_base = maybe_base.strip()
        maybe_commits = len(subprocess.check_output("git log --oneline {topic}...{base}".format(
            topic=topic,
            base=maybe_base,
        ), shell=True).splitlines())
        if not commits or maybe_commits < commits:
            commits = maybe_commits
            base = maybe_base

merge_base = subprocess.check_output("git merge-base %s %s" % (topic, base), shell=True).strip()
lines = subprocess.check_output("git diff %s..%s" % (merge_base, topic), shell=True)
lines = [l.strip() for l in lines.splitlines() if l.startswith("+")]

print "Added from {base} to {topic} (total added lines: {lines})".format(base=base, topic=topic, lines=len(lines))

commit_lines = subprocess.check_output("git log --format=format:%%B %s...%s" % (merge_base, topic), shell=True)
lines += ['+++ b/Commit Messages']
lines += ['+ ' + l.strip() for l in commit_lines.splitlines()]

file = ""
printed = True
for line in lines:
    if not line.startswith("+"):
        continue
    if line.startswith("+++"):
        file = line[len("+++ b/"):].strip()
        printed = False
    if "#" in line and "TODO" in line:
        if not printed:
            print
            print file
            printed = True
        print line[line.index("TODO"):]
    if "#" in line and "XXX" in line:
        if not printed:
            print
            print file
            printed = True
        print line[line.index("XXX"):]
    if "pylint: disable=" in line:
        if not printed:
            print
            print file
            printed = True
        print line[line.index("pylint: disable="):]
