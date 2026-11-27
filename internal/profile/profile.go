package profile

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"strconv"
	"strings"
)

type Hotspot struct {
	Rule         string `json:"rule"`
	Line         int    `json:"line"`
	EstimatedGas int    `json:"estimatedGas"`
	AllocRisk    string `json:"allocRisk"`
	Suggestion   string `json:"suggestion"`
	Before       string `json:"before"`
	After        string `json:"after"`
}
type Call struct {
	Target     string `json:"target"`
	Line       int    `json:"line"`
	CrossRealm bool   `json:"crossRealm"`
	InLoop     bool   `json:"inLoop,omitempty"`
}
type Function struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	File         string    `json:"file"`
	Line         int       `json:"line"`
	Exported     bool      `json:"exported"`
	EstimatedGas int       `json:"estimatedGas"`
	Hotspots     []Hotspot `json:"hotspots"`
	Calls        []Call    `json:"calls"`
}
type Report struct {
	Mode      string     `json:"mode"`
	TotalGas  int        `json:"totalGas"`
	Functions []Function `json:"functions"`
	Tests     []TestRun  `json:"tests,omitempty"`
	Note      string     `json:"note,omitempty"`
}
type TestRun struct {
	Package  string             `json:"package"`
	Passed   bool               `json:"passed"`
	Output   string             `json:"output"`
	TimingMS map[string]float64 `json:"timingMs"`
	GasUsed  map[string]int64   `json:"gasUsed,omitempty"`
}

var rules = map[string]Hotspot{
	"LOOP_STRING_CONCAT":     {EstimatedGas: 50, AllocRisk: "high", Suggestion: "Accumulate text with strings.Builder.", Before: "out += part", After: "builder.WriteString(part) // use builder.String() after the loop"},
	"HOT_UFMT_SPRINTF":       {EstimatedGas: 40, AllocRisk: "high", Suggestion: "Hoist invariant formatting or use typed conversions.", Before: "text := ufmt.Sprintf(\"%d\", n)", After: "text := strconv.Itoa(n)"},
	"UNBOUNDED_AVL_ITER":     {EstimatedGas: 80, AllocRisk: "medium", Suggestion: "Page by key and stop traversal at the page size.", Before: "tree.Iterate(\"\", \"\", visit)", After: "tree.Iterate(cursor, end, func(k string, v interface{}) bool {\n    visit(k, v)\n    count++\n    return count >= limit\n})"},
	"UNBOUNDED_SLICE_APPEND": {EstimatedGas: 35, AllocRisk: "high", Suggestion: "Reserve capacity using the expected result size.", Before: "var out []Item", After: "out := make([]Item, 0, len(items))"},
	"CROSS_REALM_IN_LOOP":    {EstimatedGas: 120, AllocRisk: "medium", Suggestion: "Batch work into a single realm crossing where supported.", Before: "for _, item := range items { remote.Save(cross(cur), item) }", After: "remote.SaveBatch(cross(cur), items)"},
	"LARGE_STATE_SERIALIZE":  {EstimatedGas: 90, AllocRisk: "high", Suggestion: "Read a bounded page or maintain an incremental summary.", Before: "for key, value := range state { render(key, value) }", After: "for _, key := range pageKeys { render(key, state[key]) }"},
}

type parsed struct {
	name    string
	file    *ast.File
	imports map[string]string
}

func packageName(importPath string) string {
	name := path.Base(importPath)
	if digits, ok := strings.CutPrefix(name, "v"); ok {
		if _, err := strconv.Atoi(digits); err == nil {
			return path.Base(path.Dir(importPath))
		}
	}
	return name
}

func functionName(fn *ast.FuncDecl) string {
	if fn.Recv != nil {
		return exprName(fn.Recv.List[0].Type) + "." + fn.Name.Name
	}
	return fn.Name.Name
}

func Analyze(names []string, sources map[string]string) (Report, error) {
	report := Report{Mode: "static", Functions: []Function{}}
	fs := token.NewFileSet()
	var files []parsed
	globals := map[string]map[string]bool{}
	local := map[string]string{}
	for _, name := range names {
		file, err := parser.ParseFile(fs, name, sources[name], parser.SkipObjectResolution)
		if err != nil {
			return report, err
		}
		imports := map[string]string{}
		for _, imp := range file.Imports {
			value, _ := strconv.Unquote(imp.Path.Value)
			alias := packageName(value)
			if imp.Name != nil {
				alias = imp.Name.Name
			}
			imports[alias] = value
		}
		files = append(files, parsed{name, file, imports})
		pkg := path.Dir(name) + ":" + file.Name.Name
		if globals[pkg] == nil {
			globals[pkg] = map[string]bool{}
		}
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Name.Name != "init" {
					label := functionName(d)
					local[pkg+"."+label] = name + ":" + label
				}
			case *ast.GenDecl:
				if d.Tok != token.VAR {
					continue
				}
				for _, spec := range d.Specs {
					v := spec.(*ast.ValueSpec)
					for i, id := range v.Names {
						expr := v.Type
						if expr == nil && i < len(v.Values) {
							expr = v.Values[i]
						}
						globals[pkg][id.Name] = isState(expr, imports)
					}
				}
			}
		}
	}
	for _, file := range files {
		pkg := path.Dir(file.name) + ":" + file.file.Name.Name
		for _, decl := range file.file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			name := fn.Name.Name
			line := fs.Position(fn.Pos()).Line
			id := file.name + ":" + functionName(fn)
			if name == "init" {
				id += fmt.Sprintf(":%d", line)
			}
			f := Function{ID: id, Name: name, File: file.name, Line: line, Exported: fn.Name.IsExported(), EstimatedGas: 1, Hotspots: []Hotspot{}, Calls: []Call{}}
			if fn.Body != nil {
				v := &visitor{f: &f, fs: fs, pkg: pkg, local: local, imports: file.imports, globals: globals[pkg], scope: &scope{vars: map[string]variable{}}, seen: map[string]bool{}}
				v.bindFields(fn.Recv)
				v.bindFields(fn.Type.Params)
				v.bindFields(fn.Type.Results)
				ast.Walk(v, fn.Body)
			}
			report.Functions = append(report.Functions, f)
		}
	}
	markHotPaths(&report)
	return report, nil
}

// Calls reachable from a loop can execute repeatedly even if their source has no loop.
func markHotPaths(report *Report) {
	byID := make(map[string]*Function, len(report.Functions))
	for i := range report.Functions {
		f := &report.Functions[i]
		byID[f.ID] = f
	}
	var queue []string
	for _, f := range report.Functions {
		for _, call := range f.Calls {
			if call.InLoop {
				queue = append(queue, call.Target)
			}
		}
	}
	seen := map[string]bool{}
	for i := 0; i < len(queue); i++ {
		target := queue[i]
		f := byID[target]
		if f == nil || seen[target] {
			continue
		}
		seen[target] = true
		for _, call := range f.Calls {
			queue = append(queue, call.Target)
			if !call.InLoop && strings.HasSuffix(call.Target, ".Sprintf") &&
				packageName(strings.TrimSuffix(call.Target, ".Sprintf")) == "ufmt" {
				hotspot := rules["HOT_UFMT_SPRINTF"]
				hotspot.Rule, hotspot.Line = "HOT_UFMT_SPRINTF", call.Line
				f.Hotspots = append(f.Hotspots, hotspot)
				f.EstimatedGas += hotspot.EstimatedGas
			}
		}
	}
	for _, f := range report.Functions {
		report.TotalGas += f.EstimatedGas
	}
}

type variable struct {
	text       bool
	typeName   string
	reservedAt int
}
type scope struct {
	vars   map[string]variable
	parent *scope
}
type visitor struct {
	f              *Function
	fs             *token.FileSet
	pkg            string
	local, imports map[string]string
	globals        map[string]bool
	scope          *scope
	seen           map[string]bool
	depth          int
}

func (v *visitor) put(name string, value variable) { v.scope.vars[name] = value }
func (v *visitor) bindFields(fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			v.put(name.Name, variable{typeName: exprName(field.Type), text: exprName(field.Type) == "string"})
		}
	}
}
func (v *visitor) lookup(name string) (variable, bool) {
	for s := v.scope; s != nil; s = s.parent {
		if value, ok := s.vars[name]; ok {
			return value, true
		}
	}
	return variable{}, false
}
func (v *visitor) mark(rule string, p token.Pos) {
	line := v.fs.Position(p).Line
	key := rule + strconv.Itoa(line)
	if v.seen[key] {
		return
	}
	v.seen[key] = true
	h := rules[rule]
	h.Rule, h.Line = rule, line
	v.f.Hotspots = append(v.f.Hotspots, h)
	v.f.EstimatedGas += h.EstimatedGas
}
func exprName(x ast.Expr) string {
	switch n := x.(type) {
	case *ast.Ident:
		return n.Name
	case *ast.SelectorExpr:
		return exprName(n.X) + "." + n.Sel.Name
	case *ast.StarExpr:
		return exprName(n.X)
	case *ast.ArrayType:
		if n.Len == nil {
			return "[]" + exprName(n.Elt)
		}
	case *ast.ParenExpr:
		return exprName(n.X)
	case *ast.IndexExpr:
		return exprName(n.X)
	}
	return ""
}
func isState(x ast.Expr, imports map[string]string) bool {
	switch n := x.(type) {
	case *ast.MapType:
		return true
	case *ast.CompositeLit:
		return isState(n.Type, imports)
	case *ast.CallExpr:
		if exprName(n.Fun) == "make" && len(n.Args) > 0 {
			return isState(n.Args[0], imports)
		}
		alias, _, _ := strings.Cut(exprName(n.Fun), ".")
		return packageName(imports[alias]) == "avl"
	case *ast.UnaryExpr:
		return isState(n.X, imports)
	}
	return strings.HasSuffix(exprName(x), ".Tree")
}
func (v *visitor) isText(x ast.Expr) bool {
	switch n := x.(type) {
	case *ast.BasicLit:
		return n.Kind == token.STRING
	case *ast.Ident:
		value, _ := v.lookup(n.Name)
		return value.text
	case *ast.BinaryExpr:
		return n.Op == token.ADD && (v.isText(n.X) || v.isText(n.Y))
	case *ast.ParenExpr:
		return v.isText(n.X)
	case *ast.CallExpr:
		return exprName(n.Fun) == "string" || strings.HasSuffix(exprName(n.Fun), ".Sprintf")
	}
	return false
}
func (v *visitor) binding(x ast.Expr) variable {
	value := variable{text: v.isText(x)}
	switch n := x.(type) {
	case *ast.CompositeLit:
		value.typeName = exprName(n.Type)
	case *ast.UnaryExpr:
		value.typeName = v.binding(n.X).typeName
	case *ast.Ident:
		existing, _ := v.lookup(n.Name)
		return existing
	case *ast.CallExpr:
		if exprName(n.Fun) == "make" && len(n.Args) > 0 {
			value.typeName = exprName(n.Args[0])
		}
	}
	if c, ok := x.(*ast.CallExpr); ok && exprName(c.Fun) == "make" && len(c.Args) == 3 {
		if _, ok := c.Args[0].(*ast.ArrayType); ok {
			value.reservedAt = v.depth + 1
		}
		if lit, ok := c.Args[2].(*ast.BasicLit); ok && lit.Value == "0" {
			value.reservedAt = 0
		}
	}
	return value
}
func (v *visitor) global(name string) bool {
	_, shadow := v.lookup(name)
	return !shadow && v.globals[name]
}
func (v *visitor) Visit(node ast.Node) ast.Visitor {
	switch n := node.(type) {
	case nil:
		return nil
	case *ast.BlockStmt:
		nested := *v
		nested.scope = &scope{vars: map[string]variable{}, parent: v.scope}
		for _, stmt := range n.List {
			ast.Walk(&nested, stmt)
		}
		return nil
	case *ast.ForStmt:
		nested := *v
		nested.scope = &scope{vars: map[string]variable{}, parent: v.scope}
		if n.Init != nil {
			ast.Walk(&nested, n.Init)
		}
		nested.depth++
		if n.Cond != nil {
			ast.Walk(&nested, n.Cond)
		}
		if n.Post != nil {
			ast.Walk(&nested, n.Post)
		}
		ast.Walk(&nested, n.Body)
		return nil
	case *ast.RangeStmt:
		ast.Walk(v, n.X)
		if v.global(exprName(n.X)) {
			v.mark("LARGE_STATE_SERIALIZE", n.Pos())
		}
		nested := *v
		nested.depth++
		nested.scope = &scope{vars: map[string]variable{}, parent: v.scope}
		if n.Tok == token.DEFINE {
			nested.put(exprName(n.Key), variable{})
			elementType, _ := strings.CutPrefix(v.binding(n.X).typeName, "[]")
			if v.binding(n.X).typeName == "string" {
				elementType = "rune"
			}
			nested.put(exprName(n.Value), variable{typeName: elementType, text: elementType == "string"})
		}
		ast.Walk(&nested, n.Body)
		return nil
	case *ast.FuncLit:
		nested := *v
		nested.scope = &scope{vars: map[string]variable{}, parent: v.scope}
		nested.bindFields(n.Type.Params)
		nested.bindFields(n.Type.Results)
		ast.Walk(&nested, n.Body)
		return nil
	case *ast.ValueSpec:
		for _, x := range n.Values {
			ast.Walk(v, x)
		}
		for i, id := range n.Names {
			value := variable{typeName: exprName(n.Type), text: exprName(n.Type) == "string"}
			if i < len(n.Values) {
				value = v.binding(n.Values[i])
				value.text = value.text || exprName(n.Type) == "string"
				if n.Type != nil {
					value.typeName = exprName(n.Type)
				}
			}
			v.put(id.Name, value)
		}
		return nil
	case *ast.AssignStmt:
		for _, x := range n.Rhs {
			ast.Walk(v, x)
		}
		for i, lhs := range n.Lhs {
			ast.Walk(v, lhs)
			if i >= len(n.Rhs) {
				continue
			}
			name := exprName(lhs)
			if v.depth > 0 && n.Tok == token.ADD_ASSIGN && (v.isText(lhs) || v.isText(n.Rhs[i])) {
				v.mark("LOOP_STRING_CONCAT", n.Pos())
			}
			if n.Tok == token.DEFINE {
				v.put(name, v.binding(n.Rhs[i]))
			}
			if n.Tok == token.ASSIGN {
				if c, ok := n.Rhs[i].(*ast.CallExpr); ok && exprName(c.Fun) == "append" && len(c.Args) > 0 && exprName(c.Args[0]) == name {
					continue
				}
				for s := v.scope; s != nil; s = s.parent {
					if _, ok := s.vars[name]; ok {
						s.vars[name] = v.binding(n.Rhs[i])
						break
					}
				}
			}
		}
		return nil
	case *ast.BinaryExpr:
		if v.depth > 0 && n.Op == token.ADD && v.isText(n) {
			v.mark("LOOP_STRING_CONCAT", n.Pos())
		}
	case *ast.CallExpr:
		v.call(n)
		if strings.HasSuffix(exprName(n.Fun), ".Iterate") && len(n.Args) == 3 {
			ast.Walk(v, n.Fun)
			ast.Walk(v, n.Args[0])
			ast.Walk(v, n.Args[1])
			callback := *v
			if _, ok := n.Args[2].(*ast.FuncLit); ok {
				callback.depth++
			}
			ast.Walk(&callback, n.Args[2])
			return nil
		}
	}
	return v
}
func (v *visitor) call(c *ast.CallExpr) {
	name := exprName(c.Fun)
	if name == "" {
		return
	}
	target := name
	cross := false
	alias, member, selector := strings.Cut(name, ".")
	if selector {
		if binding, ok := v.lookup(alias); ok {
			if id, found := v.local[v.pkg+"."+binding.typeName+"."+member]; found {
				target = id
			}
		} else if imp, ok := v.imports[alias]; ok {
			target = imp + "." + member
			cross = strings.Contains(imp, "/r/")
			if packageName(imp) == "ufmt" && member == "Sprintf" && v.depth > 0 {
				v.mark("HOT_UFMT_SPRINTF", c.Pos())
			}
		}
	} else if id, ok := v.local[v.pkg+"."+name]; ok {
		target = id
	}
	for i, arg := range c.Args {
		if n, ok := arg.(*ast.CallExpr); ok && exprName(n.Fun) == "cross" {
			cross = true
		}
		if i == 0 && exprName(arg) == "cross" {
			cross = true
		}
	}
	v.f.Calls = append(v.f.Calls, Call{target, v.fs.Position(c.Pos()).Line, cross, v.depth > 0})
	v.f.EstimatedGas += 3
	if v.depth > 0 && cross {
		v.mark("CROSS_REALM_IN_LOOP", c.Pos())
	}
	if name == "append" && v.depth > 0 && len(c.Args) > 0 {
		binding, _ := v.lookup(exprName(c.Args[0]))
		if binding.reservedAt == 0 || binding.reservedAt > v.depth {
			v.mark("UNBOUNDED_SLICE_APPEND", c.Pos())
		}
	}
	if strings.HasSuffix(name, ".Iterate") && len(c.Args) == 3 {
		startOpen := emptyString(c.Args[0])
		endOpen := emptyString(c.Args[1])
		if !startOpen && !endOpen {
			return
		}
		bounded := false
		if cb, ok := c.Args[2].(*ast.FuncLit); ok {
			ast.Inspect(cb.Body, func(n ast.Node) bool {
				if ret, ok := n.(*ast.ReturnStmt); ok && len(ret.Results) == 1 && exprName(ret.Results[0]) != "false" {
					bounded = true
				}
				return true
			})
		}
		if !bounded {
			v.mark("UNBOUNDED_AVL_ITER", c.Pos())
		}
		if startOpen && endOpen && v.global(strings.TrimSuffix(name, ".Iterate")) && !bounded {
			v.mark("LARGE_STATE_SERIALIZE", c.Pos())
		}
	}
}

func emptyString(x ast.Expr) bool {
	literal, ok := x.(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return false
	}
	value, err := strconv.Unquote(literal.Value)
	return err == nil && value == ""
}
