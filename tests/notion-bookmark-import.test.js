const assert = require("assert");

const notionService = require("../services/notion-service");

describe("Notion bookmark document import helpers", function () {
  it("treats bookmark blocks inside Documents & PDFs as importable attachments", function () {
    const block = {
      type: "bookmark",
      id: "abcd1234",
      bookmark: {
        url: "https://example.org/files/request-package.pdf",
        caption: [],
      },
    };

    assert.strictEqual(
      notionService.shouldImportBookmarkAsAttachment(block, "Documents & PDFs"),
      true
    );
  });

  it("ignores bookmark blocks outside a document section", function () {
    const block = {
      type: "bookmark",
      id: "abcd1234",
      bookmark: {
        url: "https://example.org/files/request-package.pdf",
        caption: [],
      },
    };

    assert.strictEqual(
      notionService.shouldImportBookmarkAsAttachment(block, "Related Coverage"),
      false
    );
  });

  it("ignores non-document bookmark URLs even inside a document section", function () {
    const block = {
      type: "bookmark",
      id: "abcd1234",
      bookmark: {
        url: "https://example.org/article/about-the-case",
        caption: [],
      },
    };

    assert.strictEqual(
      notionService.shouldImportBookmarkAsAttachment(block, "Documents & PDFs"),
      false
    );
  });
});
