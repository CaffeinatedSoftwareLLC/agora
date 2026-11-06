# Sample files for upload validation tests

Real files from open-source test suites, used by `test/unit/file-signatures.unit.test.ts` to
check the content checks in `src/lib/file-validation.ts` against what real programs write.
They are kept byte for byte (`binary` in `.gitattributes`).

| File | Format | Source | Licence |
|---|---|---|---|
| `poi-SampleSS.xls` | Excel 97-2003 (BIFF8, `Workbook` stream) | Apache POI `test-data/spreadsheet/SampleSS.xls` | Apache-2.0 |
| `poi-testEXCEL_95.xls` | Excel 95 (BIFF5, `Book` stream) | Apache POI `test-data/spreadsheet/testEXCEL_95.xls` | Apache-2.0 |
| `poi-SampleDoc.doc` | Word 97-2003 | Apache POI `test-data/document/SampleDoc.doc` | Apache-2.0 |
| `poi-basic_test_ppt_file.ppt` | PowerPoint 97-2003 | Apache POI `test-data/slideshow/basic_test_ppt_file.ppt` | Apache-2.0 |
| `jmpreader-singlecolumnsinglerow.jmp` | JMP data table | [JMPReader.jl](https://github.com/jaakkor2/JMPReader.jl) `test/singlecolumnsinglerow.jmp` | MIT |
| `fastify-encapsulation_context.drawio` | draw.io diagram (compressed) | [Fastify](https://github.com/fastify/fastify) `docs/resources/encapsulation_context.drawio` | MIT |

Apache POI: https://github.com/apache/poi (Apache License 2.0, Copyright The Apache Software Foundation).

Microsoft Project (`.mpp`), Access (`.accdb`) and AVIF have no small public samples here. The
tests build them instead: `.mpp` as a compound file holding the `CompObj` stream copied from a
real Project 2016 plan (format name only), `.accdb` from the first 24 bytes of a real Access
database's header page, and AVIF with sharp's encoder.
