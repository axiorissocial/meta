#!/bin/bash

git pull --recurse-submodules
git submodule update --init --recursive
git submodule foreach --recursive git pull origin main
