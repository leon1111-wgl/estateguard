# CNRPark attribution and derived database notice

Contains data from **CNRPark**, by Giuseppe Amato, Fabio Carrara, Fabrizio Falchi, Claudio Gennaro and Claudio Vairo (CNR).

- Original project: http://cnrpark.it/
- Author archive: https://github.com/fabiocarrara/deep-parking/releases/download/archive/CNRPark-Patches-150x150.zip
- Paper: https://doi.org/10.1109/ISCC.2016.7543901
- Database license: **Open Data Commons Open Database License (ODbL) v1.0**, https://opendatacommons.org/licenses/odbl/1-0/
- Source archive SHA-256: `2dc9b13892595e599e1f5025ddcce08ef7287babbb978670580c60abd86c5fdb`

EstateGuard redistributes the complete camera B test subset: 6,413 original JPEG patches, unchanged bytes with camera/date/time/slot IDs as filenames. The `inputs/` PNG files are derived 32×32 RGB nearest-center samples. Source labels are retained. `manifest.json` groups patches into source-time snapshots; `test-predictions.json` and `evaluation.json` add independent model outputs. No label is replaced by a model prediction.

This derived database and its changes are available under **ODbL v1.0**, not the application code's MIT license. Source content remains subject to the original data terms. No author endorsement is implied.

The entire derivative database is freely downloadable from this directory or the Git repository. The machine-readable split manifest, all additions and transformations, and code necessary to reproduce them are freely available at:

- https://github.com/leon1111-wgl/estateguard/tree/main/web/data/parking
- https://github.com/leon1111-wgl/estateguard/blob/main/docs/validation/parking-split.csv
- https://github.com/leon1111-wgl/estateguard/blob/main/scripts/train_parking.py
- https://github.com/leon1111-wgl/estateguard/blob/main/docs/PARKING_DATA.md

The application code and project's trained classifier are separately available under MIT. Dataset attribution and ODbL terms remain applicable to the source and derivative databases, including sample-based test fixtures.
