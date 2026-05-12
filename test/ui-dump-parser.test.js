import test from "node:test";
import assert from "node:assert/strict";
import { parseUiAutomatorXml } from "../index.js";

const SAMPLE_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="Hello" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="Greeting label" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[20,100][500,200]" />
    <node index="1" text="" resource-id="com.example:id/btn" class="android.widget.Button" package="com.example" content-desc="Submit button" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,300][400,400]" />
    <node index="2" text="Scroll me" resource-id="" class="android.widget.ScrollView" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,500][1080,1500]" />
  </node>
</hierarchy>`;

test("parses bounds string into [left, top, right, bottom]", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const titleNode = elements.find((e) => e.text === "Hello");
  assert.ok(titleNode, "title node should exist");
  assert.deepEqual(titleNode.bounds, [20, 100, 500, 200]);
});

test("computes center as midpoint of bounds", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const titleNode = elements.find((e) => e.text === "Hello");
  // center of [20,100][500,200] -> (260, 150)
  assert.deepEqual(titleNode.center, [260, 150]);

  const button = elements.find((e) => e.contentDescription === "Submit button");
  assert.ok(button);
  // center of [100,300][400,400] -> (250, 350)
  assert.deepEqual(button.center, [250, 350]);
});

test("maps content-desc to contentDescription", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const titleNode = elements.find((e) => e.text === "Hello");
  assert.equal(titleNode.contentDescription, "Greeting label");
});

test("maps resource-id to resourceId", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const titleNode = elements.find((e) => e.text === "Hello");
  assert.equal(titleNode.resourceId, "com.example:id/title");
});

test("parses boolean attributes as booleans", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const button = elements.find((e) => e.contentDescription === "Submit button");
  assert.equal(button.clickable, true);
  assert.equal(button.focusable, true);
  assert.equal(button.enabled, true);
  assert.equal(button.selected, false);
  assert.equal(button.checked, false);
  assert.equal(button.scrollable, false);

  const scroll = elements.find((e) => e.text === "Scroll me");
  assert.equal(scroll.scrollable, true);
  assert.equal(scroll.clickable, false);
});

test("className is populated from class attribute", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML);
  const button = elements.find((e) => e.contentDescription === "Submit button");
  assert.equal(button.className, "android.widget.Button");
});

test("clickable_only filter excludes non-clickable elements", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML, { clickableOnly: true });
  assert.equal(elements.length, 1);
  assert.equal(elements[0].contentDescription, "Submit button");
});

test("with_text_only filter excludes elements with no text or content-desc", () => {
  const elements = parseUiAutomatorXml(SAMPLE_XML, { withTextOnly: true });
  // Should include: "Hello" (has text), "Submit button" (has content-desc),
  // "Scroll me" (has text). The outer FrameLayout has neither.
  const labels = elements.map(
    (e) => e.text || e.contentDescription
  );
  assert.equal(elements.length, 3);
  assert.ok(labels.includes("Hello"));
  assert.ok(labels.includes("Submit button"));
  assert.ok(labels.includes("Scroll me"));
});

test("handles malformed/empty bounds gracefully", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="No bounds" bounds="" class="android.widget.View" clickable="false" enabled="true" focusable="false" scrollable="false" selected="false" checked="false" content-desc="" resource-id="" />
</hierarchy>`;
  const elements = parseUiAutomatorXml(xml);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].bounds, null);
  assert.equal(elements[0].center, null);
});

test("handles single node (not wrapped in array)", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Solo" class="android.widget.TextView" bounds="[0,0][10,10]" clickable="false" enabled="true" focusable="false" scrollable="false" selected="false" checked="false" content-desc="" resource-id="" />
</hierarchy>`;
  const elements = parseUiAutomatorXml(xml);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text, "Solo");
  assert.deepEqual(elements[0].center, [5, 5]);
});
