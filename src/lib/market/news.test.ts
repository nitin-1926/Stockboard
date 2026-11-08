import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newsQueryName, newsUrl, parseRss } from "./news";

const xml = readFileSync(new URL("./__fixtures__/news-in.xml", import.meta.url), "utf8");

describe("news", () => {
  it("parses items and splits the publisher off the title", () => {
    const items = parseRss(xml);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "RELIANCE Outlook for the Week",
      publisher: "Equitypandit",
      link: expect.stringMatching(/^https:\/\/news\.google\.com\/rss\/articles\//),
      pubDate: "2026-11-08T08:00:00.000Z",
      sourceUrl: "https://www.equitypandit.com",
    });
  });

  it("decodes entities and only strips the trailing publisher", () => {
    const item = parseRss(xml)[2];
    expect(item.title).toBe("M&M Q2 results - profit beats estimates");
    expect(item.publisher).toBe("The Hindu");
  });

  it("builds a quoted, 7-day, locale-specific query", () => {
    expect(newsUrl("Reliance Industries", "IN")).toBe(
      "https://news.google.com/rss/search?q=%22Reliance%20Industries%22+when:7d&hl=en-IN&gl=IN&ceid=IN:en",
    );
    expect(newsUrl("Apple Inc.", "US")).toContain("&hl=en-US&gl=US&ceid=US:en");
  });

  it("drops legal suffixes and parentheticals from the query name", () => {
    expect(newsQueryName("Apple Inc.")).toBe("Apple");
    expect(newsQueryName("INFOSYS LIMITED")).toBe("INFOSYS");
    expect(newsQueryName("Infosys (demo)")).toBe("Infosys");
    expect(newsQueryName("Tata Consultancy Services Ltd.")).toBe("Tata Consultancy Services");
    expect(newsQueryName("Vanguard S&P 500 ETF")).toBe("Vanguard S&P 500 ETF");
  });
});
