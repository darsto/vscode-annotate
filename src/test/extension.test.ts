import * as assert from "assert";
import { simple_eval } from "../simple_eval";

{
    const fn = "start = 8 + start * 3 - 1; end = 8 + end * 3 - 2";
    console.log("testing", fn);
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: 13, end: 21 });
    assert.deepStrictEqual(simple_eval(fn, { start: 0, end: 0 }), { start: 7, end: 6 });
}

{
    const fn = "start = start; end = end";
    console.log("testing", fn);
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: 2, end: 5 });
}

{
    const fn = "start = 1 - start; end = end * 2";
    console.log("testing", fn);
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: -1, end: 10 });
}

{
    const fn = "start = end - 1; end = end ";
    console.log("testing", fn);
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: 4, end: 5 });
}

{
    const fn = "start = 1;";
    console.log("testing", fn);
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: 1, end: 5 });
}

{
    const fn = "";
    console.log("testing empty fn");
    assert.deepStrictEqual(simple_eval(fn, { start: 2, end: 5 }), { start: 2, end: 5 });
}
