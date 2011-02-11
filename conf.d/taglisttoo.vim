au FileType taglist set nospell
nmap <LocalLeader>t :TlistToo<CR>

" c++ language
let tlist_cpp_settings = {
    \ 'lang': 'c++',
    \ 'format': 'CppTLFormat',
    \ 'tags': {
      \ 'n': 'namespace',
      \ 'v': 'variable',
      \ 'd': 'macro',
      \ 't': 'typedef',
      \ 'c': 'class',
      \ 'm': 'member',
      \ 'g': 'enum',
      \ 's': 'struct',
      \ 'u': 'union',
      \ 'f': 'function'
    \ }
  \ }

function! CppTLFormat(types, tags)
  let formatter = taglisttoo#util#Formatter(a:tags)
  call formatter.filename()

  for type in ['n', 'd', 't', 'g']
      let vals = filter(copy(a:tags), 'v:val.type == "' . type . '"')
      if len(vals)
        call formatter.blank()
        call formatter.format(a:types[type], vals, '')
      endif
  endfor

  let functions = filter(copy(a:tags), 'v:val.type == "f" && v:val.parent !~? "class:" && v:val.parent !~? "struct:"')
  if len(functions)
    call formatter.blank()
    call formatter.format(a:types['f'], functions, '')
  endif

  let structs = filter(copy(a:tags), 'v:val.type == "s"')
  if g:Tlist_Sort_Type == 'name'
    call sort(structs, 'taglisttoo#util#SortTags')
  endif

  for struct in structs
    call formatter.blank()
    call formatter.heading(a:types['s'], struct, '')

    let members = filter(copy(a:tags),
        \ 'v:val.type == "m" && v:val.parent == "struct:" . struct.name && v:val.name !~ struct.name . "::"')
    let methods = filter(copy(a:tags),
        \ 'v:val.type == "f" && v:val.parent == "struct:" . struct.name && v:val.name !~ struct.name . "::"')
    call formatter.format("members", members, "\t")
    call formatter.format("methods", methods, "\t")
  endfor

  let classes = filter(copy(a:tags), 'v:val.type == "c"')
  if g:Tlist_Sort_Type == 'name'
    call sort(classes, 'taglisttoo#util#SortTags')
  endif

  for class in classes
    call formatter.blank()
    call formatter.heading(a:types['c'], class, '')

    let members = filter(copy(a:tags),
        \ 'v:val.type == "m" && v:val.parent == "class:" . class.name && v:val.name !~ class.name . "::"')
    let methods = filter(copy(a:tags),
        \ 'v:val.type == "f" && v:val.parent == "class:" . class.name && v:val.name !~ class.name . "::"')
    call formatter.format("members", members, "\t")
    call formatter.format("methods", methods, "\t")
  endfor

  return formatter
endfunction
