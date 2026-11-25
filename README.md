# Ledger: bill tracking for Team Agnirath

Team Agnirath is IIT Madras' solar car team. Members buy cells, carbon fibre and parts with their own money, then need reimbursement. Before Ledger, the bills were scattered across chats and spreadsheets.

With Ledger, you upload a bill as a photo or a PDF. Ledger reads the:
- invoice date
- amount
- vendor GST number
- billed-to address

You check the details, then add who paid and whether they need reimbursement. Ledger tracks each reimbursement until it is settled.

**Live app:** https://sairamj23.github.io/Finance_ledger/

## How it works
Everything runs in the browser. Nothing is sent to a server.

```
bill ─┬─ digital PDF ─► pdf.js text layer ─► rebuild lines from glyph positions
      └─ photo / scan ─► canvas clean-up (resize, flatten lighting, Otsu threshold)
                        ─► Tesseract LSTM OCR (WebAssembly, in a Web Worker)
      ─► parser (engine.js)
           • GSTIN: 15-char pattern + mod-36 checksum; repairs OCR glyph mix-ups (0/O, 1/I, 2/Z, 9/O, extra glyphs)
           • seller vs. buyer GSTIN from the "Bill To / To:" block
           • billed-to address: strips the right-hand header column and duplicate Ship-To text
           • amounts: Indian digit grouping, ₹/Rs/USD, ignores % rates, phone numbers and dates
           • cross-check: taxable value + CGST/SGST/IGST must equal the total (also recovers a
             missing CGST/SGST half, and a ₹ sign misread as a digit)
           • every field gets a confidence score, and uncertain fields are highlighted for review
      ─► IndexedDB storage, with reimbursements grouped by member
```

## Files
- `index.html`, `styles.css`, `app.js`: the interface
- `engine.js`: image clean-up, OCR, the invoice parser and local storage
- `vendor/`: Tesseract (WebAssembly), its English model, and pdf.js
- `samples/`: example bills from the team, with bank details and phone numbers removed

## Run it locally
```
python -m http.server 8000
```
Then open http://localhost:8000.
