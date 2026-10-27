# Third-party notices

## bloub

Avatar shapes, chromatic colors, and rest-expression concepts in this plugin are
compact 2D SVG adaptations of [bloub](https://github.com/jeremy-prt/bloub) by
Jérémy Perret. The original particle/simulation engine is not included.

MIT License

Copyright (c) 2026 Jérémy Perret

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## BB builtin thread list and shared UI

`vendor/bb/` contains unmodified source from
[get-bb/bb](https://github.com/get-bb/bb), pinned to the commit recorded in
`vendor/bb/manifest.json`. This includes the builtin thread-list plugin,
shared UI, and standalone icon flavor. The original MIT license and copyright
notice are preserved in [vendor/bb/LICENSE](vendor/bb/LICENSE). Generated build
copies adapt import paths; fork-specific behavior is kept in `integration/`.
