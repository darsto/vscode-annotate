// By ChatGPT
export function simple_eval(expr: string, vars: { start: number; end: number }) {
	const evalExpr = (s: string) => {
		const tokens = s.match(/[a-z]+|\d+|[+\-*/()]/g)!;
		const prec: any = { "+": 1, "-": 1, "*": 2, "/": 2 };
		const vals: number[] = [], ops: string[] = [];
		const apply = () => {
			const b = vals.pop()!, a = vals.pop()!, o = ops.pop()!;
			vals.push(o === "+" ? a + b : o === "-" ? a - b : o === "*" ? a * b : a / b);
		};
		for (const t of tokens) {
			if (/^\d+$/.test(t)) {
				vals.push(+t);
			} else if (t in vars) {
				vals.push(vars[t as keyof typeof vars]);
			} else if (t in prec) {
				while (ops.length && prec[ops.at(-1)!] >= prec[t]) {
					apply();
				}
				ops.push(t);
			}
		}
		while (ops.length) {
			apply();
		}
		return vals[0];
	};

	for (const stmt of expr.split(";")) {
		if (!stmt.trim()) {
			continue;
		}
		const [k, v] = stmt.split("=").map(x => x.trim());
		vars[k as keyof typeof vars] = evalExpr(v);
	}
	return vars;
}
